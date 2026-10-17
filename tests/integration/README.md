# Cross-computer handoff acceptance

`test_handoff_desktop_bridge.py` is an opt-in fixture bridge for the IDE's
`console-handoff-cross-host.integration.test.ts`. It reuses the hub's migrated
temporary database, signed test principals and stub notification provider. It
binds only loopback. No deployed services, people, credentials or databases are
needed.

1. Copy the Python fixture into `tests/api/` of an isolated omniconsole
   checkout with its test dependencies installed.
2. Run from that hub checkout with `COLLABORATION_FIXTURE_BRIDGE=1` and
   `COLLABORATION_BFF_ROOT` pointing to an isolated omni-console checkout. Its
   Python environment needs both repos' dependencies. Invoke
   `python -m pytest -q -s tests/api/test_handoff_desktop_bridge.py`.
3. Read the emitted `COLLABORATION_BRIDGE` port. Forward it with SSH from a
   different fleet computer to that computer's loopback address.
4. In the IDE checkout on the second computer, run
   `COLLABORATION_BRIDGE_URL=http://127.0.0.1:<forwarded-port> pnpm test src/main/backoffice/console-handoff-cross-host.integration.test.ts`.
5. The client closes the bridge after its download/review phase; the bridge
   otherwise expires after ten minutes. Close only this test's SSH forward.

The agent request executes the real `tool_send_handoff` handler with an isolated
ToolContext and fixture provenance ledger. The native request executes the real
IDE handoff transport over HTTP; its authentication capture maps fixture bearers
to signed hub test principals. Both write to the same real hub routes/database.
The test checks common recipient history, stable replay IDs, exact downloaded
bytes on the second computer, version-specific approval and unrelated-person
denial. It does not prove production OAuth/delegation, MCP transport enrollment,
rendered UI, or a finished session's actual capture/launch path.

Without `COLLABORATION_BRIDGE_URL`, ordinary unit CI skips this opt-in test. Its
absence is not cross-computer acceptance. Preserve both test logs and their
source SHAs when recording evidence.
