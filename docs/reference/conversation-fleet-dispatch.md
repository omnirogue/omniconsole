# Dispatching conversations to the fleet

Conversations use the existing Add Next draft, action presets, and templates. The fleet
inventory retains the selected machine's advertised native providers, models, and efforts.
The normal employee picker applies `assessWorkAgentAvailability`, the same assessment
used by Start Work. Updated runners publish a bounded account-usage receipt for the
actual selected account alongside each provider capability. The picker checks that
host's receipt before offering its models and efforts. Missing, stale, failed, or
exhausted usage stays unavailable; static enrollment alone never proves readiness.
Refresh rechecks the signed inventory. The local-only `omni account usage` probe reads
the selected credentials without running a model or changing the account.
Paired-runtime conversations retain their existing owning-host installation, model
probe, and provider-account usage checks; they do not use fleet enrollment as proof.
Automatic placement considers ready machines; an explicitly selected capable machine
can retain queued work while busy. Parallel AI execution requires acknowledgement for
that dispatch.

The conversation must belong to a filed task. AI workflows require a task that can
adopt a canonical AI stage; tasks already bound to execution continue through their
existing workflow. Delivery-only workflows create separate delivery tasks and preserve
the source task's title, acceptance, status, and existing execution binding.
Preparation reads the complete retained conversation from its execution owner, uploads
the captured context and selected files through signed task-file APIs, refreshes the
task revision, and obtains a frozen server preview. Admission submits that reviewed
graph unchanged. The server owns subsequent execution and stage advancement.

## Source capture

- Native conversations retain readable turns and original source records. Structured
  conversations retain the available journal projection, with explicit warnings when
  historical tool data or referenced external blobs are unavailable.
- File capture uses the source runtime, including paired SSH hosts. File bytes, modes,
  deletions, and Git HEAD are frozen and checked before and after transfer.
- Git execution uses the exact captured commit. That commit must be fetchable from the
  registered remote; dispatch does not push local commits or substitute another base.
- Folder work receives a host-allocated folder. It does not invent a Git repository.
- Source limits are 32 files, 10 MiB per file, and 32 MiB total, including conversation
  attachments. Structural file/directory replacements and unsafe filesystem entries
  are refused explicitly. Native transcript readers also enforce record-size limits.
- Initial person-handoff manifests resolve on the source host into frozen file pins.
  The original manifests remain evidence. A requested summary is captured assistant
  output from the same conversation snapshot, with no transcript-as-summary fallback.

## Ownership and recovery

A pending receipt is saved before admission. An uncertain response retains that receipt
for reconciliation; retry within the review uses the same graph. Startup discovery is
scoped to the directing person, and full workflow reads must match task, graph digest,
conversation identity, and capture time before admission is considered verified.

Only a confirmed admission can pause the source. Cancellation addresses the captured
turn and ownership fence, or the exact native terminal and provider session. A newer
turn is preserved. Pause failures do not repeat admission or terminate the session.

Waiting, Needs you, and Completed use the existing conversation groups. Loss of contact
is unverifiable, never completion. Receipts retain access to results when the source
tab closes. A newer local turn remains visible alongside its earlier dispatched work.

## Evidence and delivery

The workflow inspector reuses the native chat renderer for transcripts and provides
paged session and event logs. Updated runners upload durable evidence before reporting
completion. Older attempts may expose only a labeled, capped saved log. Loaded evidence
can be exported without implying unloaded pages are included.

A person-handoff stage completes when delivery has a durable receipt. That receipt
does not mean the recipient approved or finished the work. Recipient work continues
through the existing handoff thread lifecycle. Subsequent workflow stages start after
delivery; they do not wait for the person's response.

### The session transcript as a deliverable

A person handoff can carry the session's own transcript ("send this transcript to
Uma"). It is a fourth deliverables kind, `{ kind: 'transcript', include: true }`, and
`include` records the owner's consent: the deliverable exists only because someone
ticked **Include the session transcript (redacted)**, which is off by default and
carries the sentence saying the transcript can include file contents and command
output from the session.

`renderTranscriptMarkdown` (`src/shared/transcript-render.ts`) is the renderer: pure and
deterministic, a header (agent, model, session, captured-at, message count, source
digest), one section per message, tool calls and results as fenced blocks clipped to
2 KiB and 4 KiB heads, and a footer naming what was clipped. A clipped payload always
carries the agent journal's truncation marker with its full byte length and digest;
reasoning and system messages are never included. A document above 8 MiB refuses
rather than shipping a transcript that silently stops mid-session.

`buildTranscriptDeliverable` (`src/main/transcripts/transcript-deliverable.ts`) runs the
observability redactor over that document as a **gate, not a scrubber**, following
`serializeConsoleWorkflowRequest`: if redaction would change a single byte the handoff
refuses with `transcript_contains_protected_data` and reports how many values matched,
never the values themselves and never a quietly rewritten transcript. The owner removes
the secret and re-runs, or sends work files instead.

The transcript travels as a file, never in the note — the hub caps a handoff body at
8,192 bytes. It is pinned at the fixed `target_path` `handoff/transcript.md`, counts
against the 32-file and 32 MiB input limits, and appends one line to the note:
`Transcript attached: <name> (<n> messages, <size>)`. A handoff sends either the
transcript or selected work files; choosing both is refused rather than silently
dropping the files.

## Rollout and verification

This feature spans the IDE/runtime, Console admission and evidence APIs, canonical hub,
and native fleet runner. Follow the Console integration rollout document; do not use
an older runner's capability report as evidence that it supports new source inputs or
folder results. Preflight must check the selected host and preserve active jobs.

The rendered Electron fixture verifies picker, review, Waiting, and evidence navigation
through an isolated app's IPC. It is not a live fleet-execution test. Live verification
must additionally prove native job progress, frozen inputs, complete evidence, and
continued execution after the dispatching UI disconnects.
