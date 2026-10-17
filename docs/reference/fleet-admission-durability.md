# Fleet admission durability

The desktop commits a receipt in main before sending admission. The receipt retains the
existing operation ID, server-minted workflow ID, task revision, reviewed graph/digest,
admission context and exact source capture (including host, session, turn, runtime fence,
transcript and graph file pins). Provider/model strings remain opaque. No new server
operation-ID or workflow-ID scheme is introduced.

`ConversationFleetJournal` uses the existing fsync/rename durable-write primitive in a
private directory under userData. Its filename hashes the configured backend, profile,
cloud user/profile and organization identity. Credentials are not part of this key.
The storage key survives process restart; the mutation-epoch fence prevents an in-flight
account switch from granting authority to a new login.

Outcome attempts belong to local action/launch state and require an outcome/action revision.
A fleet admission is not a local launch and may contain only person deliveries, so it uses
a separate admission journal rather than inventing a local outcome attempt. The desktop
owns the intent journal; source capture/pause and process observations stay on the execution
host, including SSH sources and folder workspaces.

Main verifies the exact current preview before accepting a new intent. The journal commits
`attempted` before POST. Concurrent calls and restored attempts reconcile
that same canonical command through the explicitly supported server endpoint. A timeout, 404, corrupt file or lost
contact does not authorize another workflow. Pending entries cannot be dismissed to unlock
dispatch. A new workflow for the same task/source is blocked until the existing graph has
confirmed completion. Cancellation alone is never terminal evidence.

Main imports old renderer receipts conservatively, then reconciles unresolved IDs before
returning startup receipts. An unavailable graph remains pending/unverifiable; an unreadable
journal disables admission. Renderer localStorage is only a compatibility/presentation cache
and contains neither full source transcripts nor admission authority. Imported renderer intents
are stripped before migration. Old clients that lack the optional local IPC methods fail closed;
this does not change the paired runtime wire.

Cancel and Retry are disabled in both renderer predicates and main API methods until the
server provides execution-host cancellation acknowledgement and fenced retry semantics.
Tests of the future control contract opt into that capability explicitly. Re-enabling it
requires the server semantics from omni-console #495/#498 and corresponding IDE handling;
a `cancelled` status alone must not release a possibly live process.

An intent committed just before a crash with `attempted: false` is positive durable evidence
that no POST was issued: startup may claim and send that exact approved graph once. An
already attempted intent requires the canonical reconciliation capability during recovery, including after 404 or lost contact.
Recovery never infers absence from a failed read. Live acceptance must cover interrupted admission, renderer/app restart, account
switching and Chat/Terminal switching while asserting one server workflow per operation.

Machine/file selections and the existing operation ID reuse the session-work draft hook from
PR #321, keyed by account, execution host, work location and session. Reopening a surface
keeps those choices; it does not reuse an in-memory reviewed graph after source identity changes.
The main IPC checks the renderer account/backend scope before migrating or writing receipts,
so a delayed request from an old account cannot file its source transcript under the new one.

## Canonical reconciliation contract

Main probes signed GET `/api/gtd/workflow-tasks/{task_id}/reconciliation-capabilities` for
`conversation-admission-reconciliation.v1` and `canonical_command_replay: true`, then sends
POST `/api/gtd/workflow-tasks/{task_id}/reconcile` with the exact saved admission body.
There is no fallback to `/admit` on missing/invalid capability. `attempted: false` remains
positive durable evidence permitting a safe first send through normal admission.

The server checks signed owner/task access and the frozen graph, reads canonical Hub state,
and checks `durable-workflow.v1` workflow/source-command/graph-key/digest identity before replay.
It reuses `hub_admission_command`, the original reviewed revision and approval, and the existing
admission/projection path. A successful reply includes the canonical admission receipt, jobs,
and a versioned proof binding task, workflow, digest, context digest and original revision.
Main checks those fields and the complete original job graph before persisting acceptance.

The Hub owns the race fence: canonical admission checks the original command and graph intent
digest inside its write transaction before either returning the exact original receipt or
adopting a task at the original revision. Its second commit seals the workflow revision.
Reconciliation can repair a crash between those commits even if source revision already moved;
it does not manufacture another approval or a replacement graph. A new/stale command still
fails the canonical revision fence. Source pins, person handoffs, inventory and authority checks
remain in the existing admission path; unavailable evidence stays pending.

Deployment requires the matching Console reconciliation endpoint and the existing canonical
Hub exact-command/graph-intent transaction, plus its signed-person forwarding and workflow-read
contract. The jobs progress GET remains a projection and its 404 never authorizes replay.
Console, Hub and IDE changes require integrated live acceptance before enabling recovery in a
release. Old servers keep attempted intents pending; they cannot trigger blind admission retry.

Main-created entries carry `replayAuthorized`; renderer imports never do. Pre-upgrade attempted
entries without this provenance remain read-only, since the earlier format cannot distinguish
an approved intent from a renderer import. Proven unattempted entries can upgrade when claimed.
No migration fabricates missing approval authority.
