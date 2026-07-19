#!/usr/bin/env python3
"""Credential-free smoke test for the hosted realistic-image CLI."""

import base64
import json
import os
import subprocess
import sys
import tempfile
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CLI_PATH = PROJECT_ROOT / "scripts" / "generate_realistic_images.py"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class FakeApiHandler(BaseHTTPRequestHandler):
    calls = []
    image_requests = 0

    def log_message(self, *_args):
        return

    def send_json(self, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(200)
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
                        }
                    ]
                }
            )
            return

        if self.path.endswith("/images/edits"):
            assert self.headers.get("Authorization") == "Bearer openai-test-key"
            content_type = self.headers.get("Content-Type")
            header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
            message = BytesParser(policy=policy.default).parsebytes(header + body)
            fields = {}
            file_data = None
            for part in message.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name == "image":
                    file_data = part.get_payload(decode=True)
                elif name:
                    fields[name] = (part.get_payload(decode=True) or b"").decode()
            assert fields["model"] == "fake-image-model"
            assert fields["n"] == "1"
            assert fields["prompt"]
            assert file_data == PNG_BYTES
            FakeApiHandler.image_requests += 1
            if FakeApiHandler.image_requests == 1:
                encoded = base64.b64encode(PNG_BYTES).decode("ascii")
                self.send_json({"data": [{"b64_json": encoded}]})
            else:
                self.send_json({"data": [{"url": f"http://127.0.0.1:{self.server.server_port}/generated.png"}]})
            return

        self.send_error(404)


def run_cli(args, env):
    result = subprocess.run(
        [sys.executable, str(CLI_PATH), *[str(item) for item in args]],
        cwd=PROJECT_ROOT,
        env=env,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"CLI failed with {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout, result.stderr


def assert_generated_metadata(output_dir, expected_count, provider, model):
    metadata = sorted(Path(output_dir).rglob("*.json"))
    images = sorted(
        path
        for path in Path(output_dir).rglob("*")
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    assert len(metadata) == expected_count, metadata
    assert len(images) == expected_count, images
    for path in metadata:
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["request"]["provider"] == provider
        assert payload["request"]["model"] == model
        assert "gemini-test-key" not in path.read_text(encoding="utf-8")
        assert "openai-test-key" not in path.read_text(encoding="utf-8")


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeApiHandler)
    port = server.server_port
    import threading

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
            assert_generated_metadata(gemini_output, 1, "gemini", "fake-gemini-model")

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
                    "--retries",
                    "0",
                ],
                common_env,
            )
            assert "generated=2" in stdout
            assert_generated_metadata(openai_output, 2, "openai", "fake-image-model")
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
                    "--retries",
                    "0",
                ],
                common_env,
            )
            assert "skipped=2" in stdout
            assert len(FakeApiHandler.calls) == call_count

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
