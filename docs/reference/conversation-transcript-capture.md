# Conversation transcript capture

`nativeChat.readTranscriptPage` captures the session on its owning runtime. SSH
reads use the selected host's filesystem provider; a missing provider or relay
method never falls back to the dispatcher's filesystem. Without a retained path,
`transcript.resolveSource` searches the owning host's provider index by exact
provider and session ID. Ambiguous or incomplete index results are errors.

| Indexed provider | Complete conversation source |
| --- | --- |
| Claude, Codex, Cursor, Antigravity, Copilot, Pi, OMP, Prime Agent, OpenClaw, Droid | Authoritative JSONL |
| Gemini, Hermes, Devin | Authoritative JSON/JSONL document |
| Grok | `summary.json` resolves to `chat_history.jsonl` |
| Rovo | `metadata.json` resolves to `session_context.json` |
| Cline | Session metadata resolves to its sibling messages JSON |
| Kimi | `state.json` selects the primary agent's `wire.jsonl` |
| OpenCode | Owning-host SQLite transaction or legacy session/message/part files, exported to a frozen JSONL snapshot |

Readable messages are a display projection. The capture also retains the original
JSONL record strings, including records the display parser hides. JSON fragments
join without separators; JSONL records join with LF. The client validates the
assembled JSON document before accepting capture. Large OpenCode records use
numbered envelopes whose text chunks reconstruct the complete original record.

The cursor binds provider, session, host, file identity, and captured byte range.
JSONL can grow beyond that range while capture continues. Replaced/truncated files
and same-size rewrites are refused; JSON documents must remain unchanged throughout
capture. Old relays explicitly require an update for source lookup or OpenCode
capture methods they do not implement.

Capture is bounded: individual native JSONL records are limited to 2 MiB, provider
metadata to 1 MiB, and ordinary response payloads to 3 MiB. A page scans at most
8 MiB through reads of at most 256 KiB. These are explicit refusals or incomplete
record counts, never silent truncation; the client refuses incomplete captures.
Large JSON documents are paginated instead of being limited to one record. OpenCode
exports split large records into 16 Ki character chunks and use 256 KiB relay
response budgets. At most 64 OpenCode snapshots are open or being prepared; live
snapshots expire after 30 minutes without use. Crash-abandoned exports currently
rely on system temporary-directory cleanup.

External media references remain references. In particular, Kimi capture warns
that separate attachment blob files are not included; it preserves their original
references without claiming the media payload was exported. Inline payloads in
accepted source records remain intact. Relay-owned Grok/Kimi home overrides are
explicitly supplied by the relay service; the dispatcher's environment does not
change remote discovery roots.
