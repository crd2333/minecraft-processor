#!/usr/bin/env python3
"""Convert Minecraft renderer images through hosted image-generation APIs."""

import argparse
import base64
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


TOOL_FORMAT = "minecraft-realistic-image-generation-v1"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROMPT_PATH = PROJECT_ROOT / "prompts" / "minecraft_to_realistic_v1.txt"
DEFAULTS = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "model": "gemini-3-pro-image-preview",
        "size": "auto",
        "aspect_ratio": "auto",
        "key_env": "GEMINI_API_KEY",
        "base_url_env": "GEMINI_BASE_URL",
        "model_env": "GEMINI_IMAGE_MODEL",
        "size_env": "GEMINI_IMAGE_SIZE",
        "aspect_ratio_env": "GEMINI_IMAGE_ASPECT_RATIO",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-image-1",
        "size": "auto",
        "quality": "high",
        "output_format": "png",
        "key_env": "OPENAI_API_KEY",
        "base_url_env": "OPENAI_BASE_URL",
        "model_env": "OPENAI_IMAGE_MODEL",
        "size_env": "OPENAI_IMAGE_SIZE",
        "quality_env": "OPENAI_IMAGE_QUALITY",
        "output_format_env": "OPENAI_IMAGE_OUTPUT_FORMAT",
    },
}
OPENAI_IMAGE_SIZES = {"auto", "1024x1024", "1536x1024", "1024x1536"}
OPENAI_IMAGE_QUALITIES = {"auto", "low", "medium", "high"}
OPENAI_OUTPUT_FORMATS = {"png", "jpeg", "webp"}
GEMINI_IMAGE_SIZES = {"auto", "1K", "2K", "4K"}
GEMINI_ASPECT_RATIOS = {
    "auto",
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9",
}
INPUT_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
OUTPUT_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
TRANSIENT_HTTP_STATUSES = {408, 409, 425, 429}
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 96 * 1024 * 1024
MAX_ERROR_BYTES = 16 * 1024
USER_AGENT = "minecraft-processor-realistic-image/1"


class RequestFailure(RuntimeError):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class GeneratedImage:
    data: bytes
    mime_type: str
    provider_text: str = ""


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_bytes_limited(path, maximum=MAX_INPUT_BYTES):
    path = Path(path)
    size = path.stat().st_size
    if size <= 0:
        raise ValueError(f"Input image is empty: {path}")
    if size > maximum:
        raise ValueError(f"Input image exceeds {maximum} bytes: {path}")
    return path.read_bytes()


def read_response_limited(response, maximum=MAX_RESPONSE_BYTES):
    data = response.read(maximum + 1)
    if len(data) > maximum:
        raise RequestFailure(f"API response exceeds {maximum} bytes")
    return data


def redact_url(value):
    try:
        parsed = urlsplit(str(value))
    except ValueError:
        return "<invalid-url>"

    query = []
    for key, item in parse_qsl(parsed.query, keep_blank_values=True):
        if key.lower() in {"key", "api_key", "apikey", "access_token", "token"}:
            item = "REDACTED"
        query.append((key, item))

    hostname = parsed.hostname or ""
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    netloc = hostname
    if parsed.port is not None:
        netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, urlencode(query), parsed.fragment))


def redact_text(value, api_key=None):
    text = str(value)
    if api_key:
        text = text.replace(api_key, "REDACTED")
    return re.sub(
        r"(?i)([?&](?:key|api_key|apikey|access_token|token)=)[^&\s]+",
        r"\1REDACTED",
        text,
    )


def validate_http_url(value, label):
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError(f"Invalid {label}: {error}") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an http:// or https:// URL")
    return value


def build_endpoint(provider, base_url, model):
    base_url = validate_http_url(str(base_url).strip(), "base URL")
    parsed = urlsplit(base_url)
    path = parsed.path.rstrip("/")

    if provider == "gemini":
        if path.endswith(":generateContent"):
            return base_url
        model_name = model.strip()
        if model_name.startswith("models/"):
            model_name = model_name[len("models/") :]
        suffix = f"/models/{quote(model_name, safe='._-')}:generateContent"
    else:
        if path.endswith("/images/edits"):
            return base_url
        suffix = "/images/edits"

    return urlunsplit(
        (parsed.scheme, parsed.netloc, path + suffix, parsed.query, parsed.fragment)
    )


def url_contains_api_key(url):
    return any(
        key.lower() in {"key", "api_key", "apikey", "access_token", "token"} and bool(value)
        for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=True)
    )


def mime_type_for_input(path):
    mime_type = INPUT_MIME_TYPES.get(Path(path).suffix.lower())
    if not mime_type:
        raise ValueError(f"Unsupported image extension: {Path(path).suffix or '(none)'}")
    return mime_type


def sniff_image_mime(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def normalize_generated_image(data, declared_mime=None, provider_text=""):
    if not data:
        raise RequestFailure("Provider returned an empty image")
    detected_mime = sniff_image_mime(data)
    if detected_mime is None:
        raise RequestFailure("Provider returned data that is not a supported PNG, JPEG, or WebP image")
    declared_mime = (declared_mime or "").split(";", 1)[0].strip().lower()
    mime_type = detected_mime if declared_mime not in OUTPUT_EXTENSIONS else declared_mime
    if mime_type != detected_mime:
        mime_type = detected_mime
    return GeneratedImage(data=data, mime_type=mime_type, provider_text=provider_text)


def decode_base64_image(value):
    try:
        compact = "".join(str(value).split())
        return base64.b64decode(compact, validate=True)
    except (ValueError, TypeError) as error:
        raise RequestFailure(f"Provider returned invalid base64 image data: {error}") from error


def decode_data_url(value):
    match = re.fullmatch(r"data:([^;,]+);base64,(.+)", str(value), flags=re.DOTALL)
    if not match:
        raise RequestFailure("Provider returned an invalid image data URL")
    return normalize_generated_image(decode_base64_image(match.group(2)), match.group(1))


def parse_json_response(data, provider):
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RequestFailure(f"{provider} returned invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise RequestFailure(f"{provider} returned a non-object JSON response")
    return payload


def provider_error_message(status, body, api_key):
    text = body.decode("utf-8", errors="replace").strip()
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and error.get("message"):
                text = str(error["message"])
            elif isinstance(error, str):
                text = error
            elif payload.get("message"):
                text = str(payload["message"])
    except json.JSONDecodeError:
        pass
    text = redact_text(text or "empty response body", api_key)
    if len(text) > 1000:
        text = text[:1000] + "..."
    return f"HTTP {status}: {text}"


def perform_request(request, timeout, api_key=None, maximum=MAX_RESPONSE_BYTES):
    try:
        with urlopen(request, timeout=timeout) as response:
            return read_response_limited(response, maximum), response.headers.get("Content-Type", "")
    except HTTPError as error:
        body = error.read(MAX_ERROR_BYTES)
        retryable = error.code in TRANSIENT_HTTP_STATUSES or 500 <= error.code <= 599
        raise RequestFailure(provider_error_message(error.code, body, api_key), retryable) from error
    except (URLError, TimeoutError, ConnectionError) as error:
        reason = getattr(error, "reason", error)
        raise RequestFailure(f"Network request failed: {redact_text(reason, api_key)}", True) from error


def request_with_retries(operation, retries, api_key, label):
    attempts = retries + 1
    for attempt in range(1, attempts + 1):
        try:
            return operation(), attempt
        except RequestFailure as error:
            if not error.retryable or attempt >= attempts:
                raise
            delay = min(8.0, 2 ** (attempt - 1))
            print(
                f"  {label}: transient failure ({redact_text(error, api_key)}); "
                f"retrying in {delay:g}s",
                file=sys.stderr,
            )
            time.sleep(delay)
    raise AssertionError("retry loop exhausted unexpectedly")


def require_image_count(images, requested, provider):
    if len(images) != requested:
        raise RequestFailure(
            f"{provider} returned {len(images)} image(s), expected {requested}"
        )
    return images


def gemini_request(endpoint, api_key, prompt, image_data, mime_type, generation, timeout):
    generation_config = {"responseModalities": ["TEXT", "IMAGE"]}
    image_config = {}
    if generation["imageSize"] != "auto":
        image_config["imageSize"] = generation["imageSize"]
    if generation["aspectRatio"] != "auto":
        image_config["aspectRatio"] = generation["aspectRatio"]
    if generation["numImages"] > 1:
        generation_config["candidateCount"] = generation["numImages"]
    if image_config:
        generation_config["imageConfig"] = image_config

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": base64.b64encode(image_data).decode("ascii"),
                        }
                    },
                ],
            }
        ],
        "generationConfig": generation_config,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if api_key:
        headers["x-goog-api-key"] = api_key
    request = Request(
        endpoint,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    response_data, _ = perform_request(request, timeout, api_key)
    response = parse_json_response(response_data, "Gemini")

    text_parts = []
    images = []
    for candidate in response.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content") or {}
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            if isinstance(part.get("text"), str):
                text_parts.append(part["text"])
            inline = part.get("inlineData") or part.get("inline_data")
            if not isinstance(inline, dict):
                continue
            encoded = inline.get("data")
            declared_mime = inline.get("mimeType") or inline.get("mime_type")
            if encoded:
                images.append(
                    normalize_generated_image(
                        decode_base64_image(encoded),
                        declared_mime,
                        "\n".join(text_parts).strip(),
                    )
                )

    if images:
        return require_image_count(images, generation["numImages"], "Gemini")
    details = "\n".join(text_parts).strip()
    suffix = f" Provider text: {details[:500]}" if details else ""
    raise RequestFailure(f"Gemini response did not contain an image part.{suffix}")


def multipart_field(boundary, name, value):
    return (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
        f"{value}\r\n"
    ).encode("utf-8")


def multipart_file(boundary, name, filename, mime_type, data):
    safe_filename = filename.replace('"', "_").replace("\r", "_").replace("\n", "_")
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"; filename="{safe_filename}"\r\n'
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode("utf-8")
    return header + data + b"\r\n"


def build_openai_multipart(model, prompt, image_name, image_data, mime_type, generation):
    boundary = "----minecraft-realistic-" + uuid.uuid4().hex
    body = bytearray()
    body += multipart_field(boundary, "model", model)
    body += multipart_field(boundary, "prompt", prompt)
    body += multipart_field(boundary, "n", str(generation["numImages"]))
    body += multipart_field(boundary, "size", generation["size"])
    body += multipart_field(boundary, "quality", generation["quality"])
    body += multipart_field(boundary, "output_format", generation["outputFormat"])
    body += multipart_file(boundary, "image", image_name, mime_type, image_data)
    body += f"--{boundary}--\r\n".encode("ascii")
    return bytes(body), boundary


def fetch_result_url(url, timeout):
    if str(url).startswith("data:"):
        return decode_data_url(url)
    validate_http_url(str(url), "generated image URL")
    request = Request(
        str(url),
        method="GET",
        headers={"Accept": "image/png,image/jpeg,image/webp", "User-Agent": USER_AGENT},
    )
    data, content_type = perform_request(request, timeout)
    return normalize_generated_image(data, content_type)


def openai_response_images(payload, timeout, requested):
    items = payload.get("data")
    if not isinstance(items, list) or not items:
        raise RequestFailure("OpenAI-compatible response is missing data")

    images = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise RequestFailure(f"OpenAI-compatible response data[{index - 1}] is not an object")

        image = None
        for key in ("b64_json", "base64", "image_base64"):
            if item.get(key):
                image = normalize_generated_image(decode_base64_image(item[key]))
                break

        if image is None:
            image_url = item.get("url") or item.get("image_url")
            if isinstance(image_url, dict):
                image_url = image_url.get("url")
            if image_url:
                image = fetch_result_url(image_url, timeout)
        if image is None:
            raise RequestFailure(
                f"OpenAI-compatible response data[{index - 1}] contains neither "
                "base64 image data nor an image URL"
            )
        images.append(image)

    return require_image_count(images, requested, "OpenAI-compatible API")


def openai_request(
    endpoint, model, api_key, prompt, image_path, image_data, mime_type, generation, timeout
):
    body, boundary = build_openai_multipart(
        model, prompt, Path(image_path).name, image_data, mime_type, generation
    )
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    response_data, _ = perform_request(request, timeout, api_key)
    return openai_response_images(
        parse_json_response(response_data, "OpenAI-compatible API"),
        timeout,
        generation["numImages"],
    )


def is_within(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


def discover_images(input_path, output_dir, recursive=False, limit=None):
    input_path = Path(input_path).expanduser().resolve()
    output_dir = Path(output_dir).expanduser().resolve()
    if not input_path.exists():
        raise ValueError(f"Input path does not exist: {input_path}")

    if input_path.is_file():
        mime_type_for_input(input_path)
        images = [(input_path, Path(input_path.name))]
    elif input_path.is_dir():
        if is_within(input_path, output_dir) or is_within(output_dir, input_path):
            raise ValueError("Input and output directories must not overlap")
        iterator = input_path.rglob("*") if recursive else input_path.glob("*")
        images = []
        for candidate in iterator:
            if not candidate.is_file() or candidate.suffix.lower() not in INPUT_MIME_TYPES:
                continue
            if is_within(candidate, output_dir):
                continue
            images.append((candidate.resolve(), candidate.relative_to(input_path)))
        images.sort(key=lambda item: item[1].as_posix())
    else:
        raise ValueError(f"Input path is not a regular file or directory: {input_path}")

    if not images:
        raise ValueError(f"No supported PNG, JPEG, or WebP images found under: {input_path}")
    if limit is not None:
        images = images[:limit]
    return input_path, images


def output_base(output_dir, relative_path):
    relative_text = relative_path.as_posix()
    path_tag = hashlib.sha256(relative_text.encode("utf-8")).hexdigest()[:8]
    return (
        Path(output_dir).expanduser().resolve()
        / relative_path.parent
        / f"{relative_path.stem}__{path_tag}__realistic"
    )


def output_candidates(base_path):
    candidates = [base_path.with_suffix(extension) for extension in OUTPUT_EXTENSIONS.values()]
    if base_path.parent.exists():
        for extension in OUTPUT_EXTENSIONS.values():
            pattern = re.compile(
                rf"^{re.escape(base_path.name)}__\d+{re.escape(extension)}$"
            )
            candidates.extend(
                path
                for path in base_path.parent.glob(f"{base_path.name}__*{extension}")
                if pattern.fullmatch(path.name)
            )
    return sorted(set(candidates))


def numbered_output_path(base_path, index, total, mime_type):
    extension = OUTPUT_EXTENSIONS[mime_type]
    if total == 1:
        return base_path.with_suffix(extension)
    width = max(2, len(str(total)))
    return base_path.parent / f"{base_path.name}__{index:0{width}d}{extension}"


def atomic_write_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def atomic_write_json(path, payload):
    data = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8") + b"\n"
    atomic_write_bytes(path, data)


def load_metadata(path):
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def completion_matches(
    metadata, source_sha256, prompt_sha256, provider, model, endpoint, generation, output_dir
):
    if not metadata or metadata.get("format") != TOOL_FORMAT:
        return False
    source = metadata.get("source") or {}
    request = metadata.get("request") or {}
    recorded_generation = dict(request.get("generation") or {})
    recorded_generation.setdefault("numImages", 1)
    if (
        source.get("sha256") != source_sha256
        or request.get("promptSha256") != prompt_sha256
        or request.get("provider") != provider
        or request.get("model") != model
        or request.get("endpoint") != redact_url(endpoint)
        or recorded_generation != generation
    ):
        return False

    outputs = metadata.get("outputs")
    if not isinstance(outputs, list):
        legacy_output = metadata.get("output")
        outputs = [legacy_output] if isinstance(legacy_output, dict) else []
    if len(outputs) != generation["numImages"]:
        return False
    for output in outputs:
        if not isinstance(output, dict):
            return False
        relative_output = output.get("path")
        if not isinstance(relative_output, str):
            return False
        output_path = (Path(output_dir).resolve() / relative_output).resolve()
        if not is_within(output_path, output_dir) or not output_path.is_file():
            return False
        if output.get("sha256") != sha256_file(output_path):
            return False
    return True


def existing_artifacts(base_path):
    metadata_path = base_path.with_suffix(".json")
    return [path for path in [metadata_path, *output_candidates(base_path)] if path.exists()]


def remove_stale_images(base_path, keep_paths):
    keep_paths = set(keep_paths)
    for candidate in output_candidates(base_path):
        if candidate not in keep_paths and candidate.exists():
            candidate.unlink()


def relative_output_path(path, output_dir):
    return Path(path).resolve().relative_to(Path(output_dir).resolve()).as_posix()


def load_prompt(path):
    path = Path(path).expanduser().resolve()
    try:
        prompt = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ValueError(f"Cannot read prompt file {path}: {error}") from error
    if not prompt:
        raise ValueError(f"Prompt file is empty: {path}")
    return path, prompt


def resolve_config(args):
    defaults = DEFAULTS[args.provider]
    base_url = args.base_url or os.environ.get(defaults["base_url_env"]) or defaults["base_url"]
    model = args.model or os.environ.get(defaults["model_env"]) or defaults["model"]
    api_key = args.api_key or os.environ.get(defaults["key_env"])
    model = str(model).strip()
    if not model:
        raise ValueError("Model name cannot be empty")
    endpoint = build_endpoint(args.provider, base_url, model)
    if not args.dry_run and not api_key and not url_contains_api_key(endpoint):
        raise ValueError(
            f"Missing API key. Set {defaults['key_env']} or pass --api-key "
            "(environment variables are safer)."
        )
    if args.provider == "openai" and not api_key and not args.dry_run:
        raise ValueError("OpenAI-compatible requests require OPENAI_API_KEY or --api-key")

    if args.provider == "openai":
        if args.aspect_ratio is not None:
            raise ValueError("--aspect-ratio is only supported by the Gemini provider")
        size = str(args.size or os.environ.get(defaults["size_env"]) or defaults["size"]).lower()
        quality = str(
            args.quality or os.environ.get(defaults["quality_env"]) or defaults["quality"]
        ).lower()
        output_format = str(
            args.output_format
            or os.environ.get(defaults["output_format_env"])
            or defaults["output_format"]
        ).lower()
        if output_format == "jpg":
            output_format = "jpeg"
        if size not in OPENAI_IMAGE_SIZES:
            raise ValueError(f"Unsupported OpenAI image size: {size}")
        if quality not in OPENAI_IMAGE_QUALITIES:
            raise ValueError(f"Unsupported OpenAI image quality: {quality}")
        if output_format not in OPENAI_OUTPUT_FORMATS:
            raise ValueError(f"Unsupported OpenAI output format: {output_format}")
        generation = {"size": size, "quality": quality, "outputFormat": output_format}
    else:
        if args.quality is not None or args.output_format is not None:
            raise ValueError("--quality and --output-format are only supported by the OpenAI provider")
        raw_size = args.size or os.environ.get(defaults["size_env"]) or defaults["size"]
        size = "auto" if str(raw_size).lower() == "auto" else str(raw_size).upper()
        aspect_ratio = str(
            args.aspect_ratio
            or os.environ.get(defaults["aspect_ratio_env"])
            or defaults["aspect_ratio"]
        ).lower()
        if size not in GEMINI_IMAGE_SIZES:
            raise ValueError(f"Unsupported Gemini image size: {size}")
        if aspect_ratio not in GEMINI_ASPECT_RATIOS:
            raise ValueError(f"Unsupported Gemini aspect ratio: {aspect_ratio}")
        generation = {"imageSize": size, "aspectRatio": aspect_ratio}

    generation["numImages"] = args.num_images

    return {
        "provider": args.provider,
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "endpoint": endpoint,
        "generation": generation,
    }


def generate_one(config, prompt, source_path, source_data, mime_type, timeout):
    if config["provider"] == "gemini":
        return gemini_request(
            config["endpoint"],
            config["api_key"],
            prompt,
            source_data,
            mime_type,
            config["generation"],
            timeout,
        )
    return openai_request(
        config["endpoint"],
        config["model"],
        config["api_key"],
        prompt,
        source_path,
        source_data,
        mime_type,
        config["generation"],
        timeout,
    )


def process_case(args, config, prompt_path, prompt, prompt_sha256, output_dir, source_path, relative_path):
    source_data = read_bytes_limited(source_path)
    source_sha256 = sha256_bytes(source_data)
    mime_type = mime_type_for_input(source_path)
    detected_mime = sniff_image_mime(source_data)
    if detected_mime != mime_type:
        raise ValueError(
            f"Input extension/content mismatch for {source_path}: "
            f"expected {mime_type}, detected {detected_mime or 'unknown'}"
        )
    base_path = output_base(output_dir, relative_path)
    metadata_path = base_path.with_suffix(".json")
    metadata = load_metadata(metadata_path)
    artifacts = existing_artifacts(base_path)

    if completion_matches(
        metadata,
        source_sha256,
        prompt_sha256,
        config["provider"],
        config["model"],
        config["endpoint"],
        config["generation"],
        output_dir,
    ) and not args.overwrite:
        return "skipped", metadata_path

    if artifacts and not args.overwrite:
        raise ValueError(
            f"Output artifacts already exist with incomplete or different settings at {base_path}. "
            "Pass --overwrite to replace them."
        )

    if args.dry_run:
        return "planned", metadata_path

    started_at = utc_now()
    results, attempts = request_with_retries(
        lambda: generate_one(config, prompt, source_path, source_data, mime_type, args.timeout),
        args.retries,
        config["api_key"],
        relative_path.as_posix(),
    )
    image_paths = []
    output_records = []
    for index, result in enumerate(results, start=1):
        image_path = numbered_output_path(base_path, index, len(results), result.mime_type)
        atomic_write_bytes(image_path, result.data)
        image_paths.append(image_path)
        output_records.append(
            {
                "index": index,
                "path": relative_output_path(image_path, output_dir),
                "mimeType": result.mime_type,
                "sha256": sha256_bytes(result.data),
                "bytes": len(result.data),
            }
        )

    payload = {
        "format": TOOL_FORMAT,
        "createdAt": started_at,
        "completedAt": utc_now(),
        "source": {
            "path": str(source_path),
            "relativePath": relative_path.as_posix(),
            "mimeType": mime_type,
            "sha256": source_sha256,
            "bytes": len(source_data),
        },
        "request": {
            "provider": config["provider"],
            "model": config["model"],
            "endpoint": redact_url(config["endpoint"]),
            "generation": config["generation"],
            "promptPath": str(prompt_path),
            "promptSha256": prompt_sha256,
            "prompt": prompt,
            "attempts": attempts,
        },
        "outputs": output_records,
    }
    if len(output_records) == 1:
        payload["output"] = output_records[0]
    provider_texts = [result.provider_text for result in results]
    if any(provider_texts):
        payload["response"] = {"texts": provider_texts}
    atomic_write_json(metadata_path, payload)
    remove_stale_images(base_path, image_paths)
    return "generated", image_paths


def build_parser():
    parser = argparse.ArgumentParser(
        description="Convert Minecraft renderer screenshots into photorealistic images through Gemini or an OpenAI-compatible image-edit API.",
        epilog=(
            "Configuration precedence: CLI option, provider environment variable, built-in default. "
            "Secrets: GEMINI_API_KEY or OPENAI_API_KEY. Supported inputs: PNG, JPEG, WebP."
        ),
    )
    parser.add_argument("input", type=Path, help="Input image or directory")
    parser.add_argument("--provider", choices=sorted(DEFAULTS), required=True, help="Image API provider")
    parser.add_argument("--output", type=Path, required=True, help="Output directory")
    parser.add_argument("--base-url", help="Provider API root or complete generation/edit endpoint")
    parser.add_argument("--model", help="Provider model (overrides the provider environment variable)")
    parser.add_argument(
        "--size",
        help="Output size: OpenAI auto/1024x1024/1536x1024/1024x1536; Gemini auto/1K/2K/4K",
    )
    parser.add_argument(
        "--quality",
        help="OpenAI quality: auto, low, medium, or high (default: high)",
    )
    parser.add_argument(
        "--output-format",
        help="OpenAI output format: png, jpeg, or webp (default: png)",
    )
    parser.add_argument(
        "--aspect-ratio",
        help="Gemini aspect ratio such as 1:1 or 16:9 (default: auto)",
    )
    parser.add_argument(
        "--api-key",
        help="API key override; prefer GEMINI_API_KEY or OPENAI_API_KEY to keep secrets out of process listings",
    )
    parser.add_argument(
        "--prompt-file",
        type=Path,
        default=DEFAULT_PROMPT_PATH,
        help=f"Prompt text file (default: {DEFAULT_PROMPT_PATH})",
    )
    parser.add_argument("--recursive", action="store_true", help="Recurse into an input directory")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing output artifacts")
    parser.add_argument("--dry-run", action="store_true", help="Validate and list work without requiring a key or calling an API")
    parser.add_argument("--limit", type=int, help="Process at most the first N discovered images")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="Maximum in-flight cases (default: 1)",
    )
    parser.add_argument(
        "--num-images",
        type=int,
        default=1,
        help="Images requested per case, from 1 to 8 (default: 1)",
    )
    parser.add_argument("--timeout", type=float, default=300.0, help="Per-request timeout in seconds (default: 300)")
    parser.add_argument("--retries", type=int, default=2, help="Retries after transient failures (default: 2)")
    return parser


def validate_args(args):
    if args.limit is not None and args.limit <= 0:
        raise ValueError("--limit must be a positive integer")
    if args.timeout <= 0:
        raise ValueError("--timeout must be positive")
    if args.retries < 0:
        raise ValueError("--retries cannot be negative")
    if args.concurrency <= 0 or args.concurrency > 64:
        raise ValueError("--concurrency must be between 1 and 64")
    if args.num_images <= 0 or args.num_images > 8:
        raise ValueError("--num-images must be between 1 and 8")


def run(args):
    validate_args(args)
    output_dir = args.output.expanduser().resolve()
    prompt_path, prompt = load_prompt(args.prompt_file)
    prompt_sha256 = sha256_bytes(prompt.encode("utf-8"))
    config = resolve_config(args)
    _, images = discover_images(args.input, output_dir, args.recursive, args.limit)

    print(f"Provider: {config['provider']} / {config['model']}")
    print(f"Endpoint: {redact_url(config['endpoint'])}")
    print("Generation: " + ", ".join(f"{key}={value}" for key, value in config["generation"].items()))
    print(f"Concurrency: {args.concurrency}")
    print(f"Prompt: {prompt_path} ({prompt_sha256[:12]})")
    print(f"Images: {len(images)}")
    if args.dry_run:
        print("Mode: dry-run (no API requests will be sent)")

    counts = {"generated": 0, "skipped": 0, "planned": 0, "failed": 0, "output_images": 0}

    def execute_case(source_path, relative_path):
        return process_case(
            args,
            config,
            prompt_path,
            prompt,
            prompt_sha256,
            output_dir,
            source_path,
            relative_path,
        )

    def report_case(index, relative_path, outcome=None, error=None):
        label = f"[{index}/{len(images)}] {relative_path.as_posix()}"
        if error is not None:
            counts["failed"] += 1
            print(f"{label}: failed: {redact_text(error, config['api_key'])}", file=sys.stderr)
            return
        status, result = outcome
        counts[status] += 1
        if status == "planned":
            base_path = output_base(output_dir, relative_path)
            suffix = ".*" if args.num_images == 1 else f"__01..{args.num_images:02d}.*"
            print(f"{label}: planned {args.num_images} image(s) -> {base_path.name}{suffix}")
        elif status == "generated":
            counts["output_images"] += len(result)
            print(f"{label}: generated {len(result)} image(s) -> {result[0].parent}")
        else:
            print(f"{label}: {status} -> {result}")

    indexed_images = [
        (index, source_path, relative_path)
        for index, (source_path, relative_path) in enumerate(images, start=1)
    ]
    if args.dry_run or args.concurrency == 1:
        for index, source_path, relative_path in indexed_images:
            try:
                report_case(index, relative_path, execute_case(source_path, relative_path))
            except Exception as error:
                report_case(index, relative_path, error=error)
    else:
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            image_iterator = iter(indexed_images)
            futures = {}

            def submit_next_case():
                try:
                    index, source_path, relative_path = next(image_iterator)
                except StopIteration:
                    return False
                futures[executor.submit(execute_case, source_path, relative_path)] = (
                    index,
                    relative_path,
                )
                return True

            for _ in range(min(args.concurrency, len(indexed_images))):
                submit_next_case()
            while futures:
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
                for future in completed:
                    index, relative_path = futures.pop(future)
                    try:
                        report_case(index, relative_path, future.result())
                    except Exception as error:
                        report_case(index, relative_path, error=error)
                    submit_next_case()

    print(
        "Summary: "
        f"generated={counts['generated']} skipped={counts['skipped']} "
        f"planned={counts['planned']} failed={counts['failed']} "
        f"output_images={counts['output_images']}"
    )
    return 1 if counts["failed"] else 0


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except (OSError, ValueError, RequestFailure) as error:
        api_key = getattr(args, "api_key", None)
        print(f"Error: {redact_text(error, api_key)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
