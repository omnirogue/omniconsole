"""Preloaded, authenticated loopback worker. No model downloads in this process."""
import argparse
import contextlib
import hmac
import json
import os
from pathlib import Path
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from checkpoint import MANIFEST, verify
from request_limits import check_request, parse_request

PROTOCOL = "omni-laya-shadow.v1"
MAX_BYTES = 64 * 1024


def load_agent(root, device):
    verify(root)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root / "source"))
    import laya
    import torch
    torch.set_num_threads(2)
    with contextlib.redirect_stdout(sys.stderr):
        agent = laya.Agent(str(root / "model"), device=device)
    if str(agent.device) != device:
        raise ValueError("device_mismatch")
    return agent


def serve(root, settings_path, device):
    token = json.loads(settings_path.read_text())["token"]
    if not isinstance(token, str) or len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise ValueError("invalid_token")
    started = time.monotonic()
    agent = load_agent(root.resolve(strict=True), device)
    from laya.common import render_options, serialize_state

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_):
            pass

        def respond(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != "/v1/decision" or self.headers.get("Origin") is not None:
                self.respond(403, {})
                return
            auth = self.headers.get_all("Authorization", [])
            if len(auth) != 1 or not hmac.compare_digest(auth[0], "Bearer " + token):
                self.respond(401, {})
                return
            try:
                sizes = self.headers.get_all("Content-Length", [])
                if len(sizes) != 1 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("invalid_request")
                size = int(sizes[0])
                if not 0 < size <= MAX_BYTES:
                    raise ValueError("input_too_large")
                request = parse_request(self.rfile.read(size))
                if request.get("protocol") != PROTOCOL or request.get("model") != MANIFEST["model"]:
                    raise ValueError("invalid_request")
                check_request(agent, request, render_options, serialize_state)
                if str(agent.device) != device:
                    raise ValueError("device_mismatch")
                with contextlib.redirect_stdout(sys.stderr):
                    result = agent.predict(request["state"], request["questions"])
                if str(agent.device) != device:
                    raise ValueError("device_mismatch")
                self.respond(200, {
                    "protocol": PROTOCOL, "provider": "laya-local", "model": MANIFEST["model"],
                    "answers": result["answers"],
                    "usage": {"inputTokens": result["usage"]["input_tokens"], "outputTokens": 0}
                })
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.respond(413 if isinstance(error, ValueError) and str(error) == "input_too_large" else 422, {})

    server = HTTPServer(("127.0.0.1", 47831), Handler)
    print(json.dumps({"ready": True, "model": MANIFEST["model"], "device": device,
                      "loadMs": round((time.monotonic() - started) * 1000)}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda", "mps"], default="cpu")
    args = parser.parse_args()
    serve(args.checkpoint, args.settings, args.device)
