"""Opt-in fixture bridge; run inside the hub test tree with its real-auth fixtures.

Only loopback is served. A desktop client on another fleet host reaches it over
SSH. Fixture bearers map to signed test principals; no production credentials or
notification providers are used. This is not the production BFF auth transport.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import sys
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from tests.api.test_handoff_files_forward import (
    _run, board, eve, sal, tmp_path, uma,  # noqa: F401
)

pytestmark = pytest.mark.real_auth


def test_desktop_bridge(board, sal, uma, eve, tmp_path, monkeypatch):
    if os.environ.get("COLLABORATION_FIXTURE_BRIDGE") != "1":
        pytest.skip("explicit isolated bridge invocation required")
    workspace = tmp_path / "source-work"
    task_id = board.make_card(workspace)
    content = b"Isolated cross-host handoff\nExact bytes: \xf0\x9f\x93\x8e\n"
    (workspace / "proposal.txt").write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    headers = {"fixture-sender": sal, "fixture-recipient": uma, "fixture-outsider": eve}
    done = False
    agent_thread = None
    bff_root = os.environ.get("COLLABORATION_BFF_ROOT")
    if bff_root:
        sys.path[:0] = [str(Path(bff_root) / "bff"), str(Path(bff_root) / "shared"), str(Path(bff_root) / "node-agent")]
        from omni_bff import gtd_store, mcp_server

        # Seed this fixture card's provenance; no deployed ledger is read or changed.
        monkeypatch.setattr(gtd_store, "card_created_here", lambda value: value == task_id)

        class Hub:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def get(self, path, **kwargs):
                return _run(board.client.get(path, headers=sal, params=kwargs.get("params")))

        def send(_hub, path, body, *, method, delegation):
            assert delegation.principal["employee_id"] == "emp_sal"
            response = _run(board.client.request(method, path, headers=sal, json=body))
            return {"ok": response.status_code == 200, "status": response.status_code,
                    "payload": response.json(), "reason": response.text if response.status_code != 200 else None}

        context = mcp_server.ToolContext(
            principal={"employee_id": "emp_sal", "role": "admin", "sections": ["work"]},
            grant={"scopes": ["tasks:write"]}, hub_client=Hub, send=send,
        )
        arguments = {"task_id": task_id, "to": "emp_uma", "action": "review",
                     "note": "Agent tool review of the same fixture work.",
                     "files": ["proposal.txt"],
                     "file_versions": [{"path": "proposal.txt", "sha256": digest}],
                     "operation_id": "agent-cross-host-0914"}
        agent = mcp_server.tool_send_handoff(context, arguments)
        agent_thread = agent["thread"]["id"]
        assert mcp_server.tool_send_handoff(context, arguments)["thread"]["id"] == agent_thread

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.dispatch()

        def do_POST(self):
            self.dispatch()

        def dispatch(self):
            nonlocal done
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if token not in headers:
                self.send_error(401)
                return
            if self.path == "/fixture" and self.command == "GET":
                self.respond(200, json.dumps({"taskId": task_id, "sha256": digest,
                    "path": "proposal.txt", "text": content.decode(), "agentThreadId": agent_thread, "sourceHost": socket.gethostname()}).encode())
                return
            if self.path == "/finish" and self.command == "POST":
                done = True
                self.respond(200, b'{"ok":true}')
                return
            prefix = "/api/gtd/hub"
            path = self.path.removeprefix(prefix)
            if not self.path.startswith(prefix) or not (
                path.startswith("/api/handoffs") or path == f"/api/team/tasks/{task_id}/handoffs"
            ):
                self.send_error(404)
                return
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            response = _run(board.client.request(self.command, path, headers={
                **headers[token], "Content-Type": "application/json"
            }, content=body or None))
            self.respond(response.status_code, response.content,
                         response.headers.get("content-type", "application/json"))

        def respond(self, status, body, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 1
        print("COLLABORATION_BRIDGE=" + json.dumps({"port": server.server_port}), flush=True)
        deadline = time.monotonic() + 600
        while not done and time.monotonic() < deadline:
            server.handle_request()
    assert done, "desktop did not finish within fixture lifetime"
    assert len(board.rows("handoff_threads")) >= 1
    print("COLLABORATION_RECEIPTS=" + json.dumps({
        "threads": [row["id"] for row in board.rows("handoff_threads")],
        "sha256": digest,
        "external_notifications": "fixture only",
    }), flush=True)
