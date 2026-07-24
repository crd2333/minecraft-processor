#!/usr/bin/env python3
"""Credential-free smoke test for the hosted realistic-image CLI."""

import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = PROJECT_ROOT / "scripts" / "generate_realistic_images.py"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class FakeApiHandler(BaseHTTPRequestHandler):
    calls = []
    lock = threading.Lock()
    active_openai_requests = 0
    max_active_openai_requests = 0
    fail_partial_topup = True

    def log_message(self, *_args):
        return

    def send_json(self, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json_error(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/generated.png":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(PNG_BYTES)))
        self.end_headers()
        self.wfile.write(PNG_BYTES)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        FakeApiHandler.calls.append(self.path)
        if self.path.endswith(":generateContent"):
            assert self.headers.get("x-goog-api-key") == "gemini-test-key"
            payload = json.loads(body.decode("utf-8"))
            parts = payload["contents"][0]["parts"]
            assert parts[0]["text"]
            inline = parts[1]["inline_data"]
            assert inline["mime_type"] == "image/png"
            assert base64.b64decode(inline["data"]) == PNG_BYTES
            assert payload["generationConfig"]["imageConfig"] == {
                "imageSize": "2K",
                "aspectRatio": "16:9",
            }
            assert payload["generationConfig"]["candidateCount"] == 2
            encoded = base64.b64encode(PNG_BYTES).decode("ascii")
            self.send_json(
                {
                    "candidates": [
                        {
                            "content": {
                                "parts": [
                                    {"text": "fake provider note"},
                                    {"inlineData": {"mimeType": "image/png", "data": encoded}},
                                ]
                            }
                        },
                        {
                            "content": {
                                "parts": [
                                    {"inlineData": {"mimeType": "image/png", "data": encoded}}
                                ]
                            }
                        },
                    ]
                }
            )
            return

        if self.path.endswith("/images/edits"):
            with FakeApiHandler.lock:
                FakeApiHandler.active_openai_requests += 1
                FakeApiHandler.max_active_openai_requests = max(
                    FakeApiHandler.max_active_openai_requests,
                    FakeApiHandler.active_openai_requests,
                )
            try:
                assert self.headers.get("Authorization") == "Bearer openai-test-key"
                content_type = self.headers.get("Content-Type")
                header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
                message = BytesParser(policy=policy.default).parsebytes(header + body)
                fields = {}
                file_data = None
                filename = None
                for part in message.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    if name == "image":
                        file_data = part.get_payload(decode=True)
                        filename = part.get_filename()
                    elif name:
                        fields[name] = (part.get_payload(decode=True) or b"").decode()
                assert fields["model"] == "fake-image-model"
                requested = int(fields["n"])
                assert requested in {1, 2}
                assert fields["size"] == "auto"
                assert fields["quality"] == "high"
                assert fields["output_format"] == "png"
                assert fields["prompt"]
                assert file_data == PNG_BYTES
                time.sleep(0.1)
                encoded = base64.b64encode(PNG_BYTES).decode("ascii")
                if (
                    filename == "partial.png"
                    and requested == 1
                    and FakeApiHandler.fail_partial_topup
                ):
                    self.send_json_error(
                        503,
                        {"error": "temporary top-up failure", "retry_after": 0},
                    )
                    return
                if requested == 2:
                    # Relays sometimes under-deliver n=2. The CLI must save this
                    # result and issue a separate n=1 top-up request.
                    self.send_json({"data": [{"b64_json": encoded}]})
                else:
                    self.send_json(
                        {
                            "data": [
                                {
                                    "url": f"http://127.0.0.1:{self.server.server_port}/generated.png"
                                }
                            ]
                        }
                    )
            finally:
                with FakeApiHandler.lock:
                    FakeApiHandler.active_openai_requests -= 1
            return

        self.send_error(404)


def run_cli(args, env):
    result = run_cli_raw(args, env)
    if result.returncode != 0:
        raise AssertionError(
            f"CLI failed with {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout, result.stderr


def run_cli_raw(args, env):
    result = subprocess.run(
        [sys.executable, str(CLI_PATH), *[str(item) for item in args]],
        cwd=PROJECT_ROOT,
        env=env,
        text=True,
        capture_output=True,
    )
    return result


def assert_generated_metadata(output_dir, expected_cases, expected_images, provider, model, generation):
    metadata = sorted(Path(output_dir).rglob("*.json"))
    images = sorted(
        path
        for path in Path(output_dir).rglob("*")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    assert len(metadata) == expected_cases, metadata
    assert len(images) == expected_images, images
    for path in metadata:
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["request"]["provider"] == provider
        assert payload["request"]["model"] == model
        assert payload["request"]["generation"] == generation
        assert len(payload["outputs"]) == generation["numImages"]
        if generation["numImages"] > 1:
            assert payload["outputs"][0]["path"].endswith("__01.png")
            assert payload["outputs"][1]["path"].endswith("__02.png")
        assert "gemini-test-key" not in path.read_text(encoding="utf-8")
        assert "openai-test-key" not in path.read_text(encoding="utf-8")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeApiHandler)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="minecraft-realistic-smoke-") as temporary:
            root = Path(temporary)
            inputs = root / "inputs"
            inputs.mkdir()
            (inputs / "a.png").write_bytes(PNG_BYTES)
            (inputs / "nested").mkdir()
            (inputs / "nested" / "b.png").write_bytes(PNG_BYTES)

            prompt = root / "prompt.txt"
            prompt.write_text("fake prompt", encoding="utf-8")
            common_env = os.environ.copy()
            common_env.update({"PYTHONUNBUFFERED": "1"})

            gemini_output = root / "gemini-output"
            stdout, _ = run_cli(
                [
                    inputs / "a.png",
                    "--provider",
                    "gemini",
                    "--base-url",
                    f"http://127.0.0.1:{port}/v1beta",
                    "--model",
                    "fake-gemini-model",
                    "--size",
                    "2K",
                    "--aspect-ratio",
                    "16:9",
                    "--num-images",
                    "2",
                    "--api-key",
                    "gemini-test-key",
                    "--prompt-file",
                    prompt,
                    "--output",
                    gemini_output,
                    "--retries",
                    "0",
                ],
                common_env,
            )
            assert "generated=1" in stdout
            assert_generated_metadata(
                gemini_output,
                1,
                2,
                "gemini",
                "fake-gemini-model",
                {"imageSize": "2K", "aspectRatio": "16:9", "numImages": 2},
            )

            openai_output = root / "openai-output"
            stdout, _ = run_cli(
                [
                    inputs,
                    "--provider",
                    "openai",
                    "--base-url",
                    f"http://127.0.0.1:{port}/v1",
                    "--model",
                    "fake-image-model",
                    "--api-key",
                    "openai-test-key",
                    "--prompt-file",
                    prompt,
                    "--output",
                    openai_output,
                    "--recursive",
                    "--concurrency",
                    "2",
                    "--num-images",
                    "2",
                    "--retries",
                    "0",
                ],
                common_env,
            )
            assert "generated=2" in stdout
            assert "output_images=4" in stdout
            assert FakeApiHandler.max_active_openai_requests >= 2
            assert_generated_metadata(
                openai_output,
                2,
                4,
                "openai",
                "fake-image-model",
                {
                    "size": "auto",
                    "quality": "high",
                    "outputFormat": "png",
                    "numImages": 2,
                },
            )
            call_count = len(FakeApiHandler.calls)

            stdout, _ = run_cli(
                [
                    inputs,
                    "--provider",
                    "openai",
                    "--base-url",
                    f"http://127.0.0.1:{port}/v1",
                    "--model",
                    "fake-image-model",
                    "--api-key",
                    "openai-test-key",
                    "--prompt-file",
                    prompt,
                    "--output",
                    openai_output,
                    "--recursive",
                    "--concurrency",
                    "2",
                    "--num-images",
                    "2",
                    "--retries",
                    "0",
                ],
                common_env,
            )
            assert "skipped=2" in stdout
            assert len(FakeApiHandler.calls) == call_count

            partial_input = root / "partial.png"
            partial_input.write_bytes(PNG_BYTES)
            partial_output = root / "partial-output"
            partial_args = [
                partial_input,
                "--provider",
                "openai",
                "--base-url",
                f"http://127.0.0.1:{port}/v1",
                "--model",
                "fake-image-model",
                "--api-key",
                "openai-test-key",
                "--prompt-file",
                prompt,
                "--output",
                partial_output,
                "--num-images",
                "2",
                "--retries",
                "0",
            ]
            partial_result = run_cli_raw(partial_args, common_env)
            assert partial_result.returncode == 1
            assert "partial 1/2 image(s) saved" in partial_result.stderr
            partial_metadata = next(partial_output.glob("*.json"))
            partial_payload = json.loads(partial_metadata.read_text(encoding="utf-8"))
            assert partial_payload["status"] == "partial"
            assert len(partial_payload["outputs"]) == 1
            partial_call_count = len(FakeApiHandler.calls)

            FakeApiHandler.fail_partial_topup = False
            stdout, _ = run_cli(partial_args, common_env)
            assert "generated=1" in stdout
            assert len(FakeApiHandler.calls) == partial_call_count + 1
            completed_payload = json.loads(partial_metadata.read_text(encoding="utf-8"))
            assert completed_payload["status"] == "complete"
            assert len(completed_payload["outputs"]) == 2

            dry_output = root / "dry-output"
            stdout, _ = run_cli(
                [
                    inputs,
                    "--provider",
                    "gemini",
                    "--base-url",
                    f"http://127.0.0.1:{port}/v1beta",
                    "--model",
                    "fake-gemini-model",
                    "--prompt-file",
                    prompt,
                    "--output",
                    dry_output,
                    "--recursive",
                    "--dry-run",
                    "--num-images",
                    "2",
                ],
                common_env,
            )
            assert "planned=2" in stdout
            assert not dry_output.exists()

    finally:
        server.shutdown()
        server.server_close()
    print("Realistic image API smoke test passed")


if __name__ == "__main__":
    main()
