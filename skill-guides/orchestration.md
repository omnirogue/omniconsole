---
name: orchestration
description: >-
  Use Orca orchestration for structured multi-agent coordination: threaded
  messages, blocking ask/reply flows, task dispatch, worker_done/escalation
  waits, task DAGs, decision gates, coordinator loops, or decomposing work
  across agents. Use `omni-cli` instead for full ownership handoffs, including
  requests phrased as "hand off", "handoff", "handover", "give this to another
  agent", or "another worktree" when the user did not explicitly ask to
  supervise, monitor, wait for results, or coordinate a DAG. Use `omni-cli` for
  ordinary terminal control, lightweight terminal prompts, shell commands, Orca
  worktree management, reading or waiting on terminals, and automation of the
  browser embedded inside Orca. Use Computer Use for browser windows, webviews,
  Orca app UI, or desktop UI outside Orca's embedded browser.
---

# Orca Inter-Agent Orchestration

Orchestration is Orca's structured coordination layer for agent messages, task ownership, dispatch state, and worker completion tracking.

## Hub authority in 1.7.0

For admitted work, the omnios card owns the business task, decisions, next action,
and verified completion. Local Runs, Tasks, dispatches, and `worker_done` are
execution bookkeeping. They cannot accept, complete, cancel, reassign, publish,
or spend on behalf of a card. Use the person's `omni-console` MCP for those actions.

To Do launches already bind to their existing card. For explicit admission after
creating or adopting a card through omnios, `omni orchestration run-create
--objective <text> --hub-task-id <btk_id>` starts a bound execution Run. This never
creates a card. Its response includes `projectionTaskId`, the existing card's
local execution placeholder; use that ID with `worker-start`. Local `task-create`
and dependency graphs are refused for bound Runs. Plan business nodes through
omnios. Child workers inherit the card identity. Ad hoc work stays local;
tab discovery, telemetry, and session restoration never create To Do items.

Start with `whoami`, `get_task` and its `resume`, then `knowledge_search`. Leave
progress notes and a `final_report` with evidence and `knowledge[]` before
`complete_task`. A local worker exit or `worker_done` never completes the card.
On bound execution Tasks, local `gate-create` requires `--decision-scope execution`;
business decision gates must be created and resolved through omnios.

Use this skill when coordination state matters. For lightweight terminal prompts or basic worktree/terminal/built-in-browser control, use `omni-cli`.

## Tool Boundary

When Orca is the selected executor for admitted work, bind the Run and use its
existing card projection with `omni orchestration worker-start`. Find the Task
through `projectionTaskId` or `task-list --run <run_id>`. The low-level
`dispatch --inject` path cannot launch bound work because it does not establish
the required worker environment. For unadmitted local work, create the local
Task with `task-create` and use the existing worker-start or dispatch flow.

The hub selects the executor for admitted work. Orca task/dispatch receipts
describe work actually executed by Orca; another adapter reports its own real
execution identity to the same hub card. Do not claim another adapter's work as
an Orca dispatch or create a second business plan to run it.

Before claiming a worker was orchestrated, verify the task/dispatch exists:

```bash
omni orchestration task-list --json
omni orchestration dispatch-show --task <task_id> --json
```

If work ran through another executor, record that provenance and its actual
evidence on the hub card. Do not rerun completed actions merely to manufacture
Orca provenance. Any required new attempt follows the card's current state and
the selected adapter's normal admission and recovery rules.

## When To Use

Choose the execution lifetime before creating a session:

- Use provider-native subagents for bounded internal work when the parent can collect the
  result and owns all follow-up. Codex-to-Codex and Claude-to-Claude investigations, tests,
  components and verification often fit. They remain in the parent's child-agent history;
  do not create an Orca conversation merely to get another context window.
- Use an Orca finite worker when the child needs independent execution, another provider,
  host/account, a separate workspace or durable Run delivery. The parent owns acceptance
  and cleanup; the human should not have to manage the helper afterwards.
- Use a durable conversation for human-launched work, an explicit ownership handoff,
  ongoing collaboration or a requested independent resume surface. Background placement
  is not an execution lifetime.

Native children are not Orca Dispatches. Preserve their actual provenance and collect their
results through the provider's tools; never invent Run/Dispatch receipts for them. A child
that needs independent supervision or must outlive its parent's available execution belongs
on the finite-worker path. Same family alone is not sufficient evidence for either choice.

- Send/reply/ask between agent terminals with persistent messages.
- Dispatch structured tasks to workers and wait for `worker_done` or `escalation`.
- Track task DAGs with dependencies.
- Run coordinator loops or decision gates.

Do not use orchestration merely because the user says "hand off", "handoff", "handover", "give this to another agent", or asks for another worktree/agent/model/effort. Those are full ownership transfers unless the user explicitly asks to supervise, monitor, wait for worker completion/results, coordinate a DAG, use decision gates, or keep a blocking ask/reply loop.

## Preconditions

- `omni status --json` should show a running runtime.
- `omni` must be on PATH (`omni-ide` on Linux).
- The orchestration experimental feature must be enabled in Settings > Experimental.
- `omni orchestration` commands are RPC calls to the running Orca runtime.

## Contract Migration

Orca adopts a live pre-update orchestration assignment into an ordinary Run. Adoption preserves the existing agent process, PTY/session, terminal handle, tab/leaf/pane, worktree or folder workspace, Task, and Dispatch; it never restarts or replaces the worker. The retired scheduler is not revived, and a newly created attempt uses the current grammar.

Treat the authority label on injected or formatted messages as definitive:

- `[LEGACY COMPATIBILITY]` is live and attested. Run only the exact supported command printed with the message, using the same CLI executable and arguments that the original prompt supplied.
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]` is one bounded, at-least-once cutover replay. Process it idempotently and acknowledge it only through the exact displayed guidance.
- `[LEGACY READ-ONLY]` is inspection-only. It has no reply, acknowledgment, or lifecycle action.
- An unlabeled current message uses the current guide and current grammar.

An explicitly selected current Run, attested current Run binding, current Dispatch, or federated attachment takes precedence over legacy fallback. A retained adoption record alone never turns a current command into a legacy call.

Database provenance, an old-looking terminal, or a legacy Run ID does not prove mutation authority. If the runtime cannot prove liveness, principal ownership, capability, or the exact legacy contract, it degrades to read-only inspection and must not fall back to local execution. Exact recovery may restore the already-live PTY once in its original inactive background tab. It must not spawn, write, signal, stop, switch, focus, split, or inject a terminal. Loss of lifecycle authority does not invalidate the existing assignment, process, or filesystem work.

Compatibility retries have narrow guarantees. A pending ask, a reply, a final Dispatch settlement, and a consuming check have durable recovery identities. A-era heartbeat and escalation calls remain at-least-once across a manual A-to-B retry because identical later signals may be intentional. If an A-era ask may already have been answered, run the exact non-consuming recovery check printed by the runtime first; after its answer is printed and acknowledged, a new invocation with the same question creates a new question. Never guess among multiple identical question threads.

When a compatibility or recovery command returns structured next-step arguments, run those exact arguments with the same CLI executable. The arguments intentionally omit the executable name so the guidance works with `omni`, `omni-ide`, `omni-dev`, or another configured Orca CLI command. Do not translate the command from memory, broaden its recipient, or retry it as a current mutation unless the returned guidance explicitly says to.

On packaged Windows, a legacy ask uses a two-step commit/resume protocol. The initial command durably commits the question, prints its exact `ask --resume <message_id>` command, and exits with launcher status `75`; it does not wait for the answer. Run that exact resume command after the launcher or update boundary. Resume is idempotent and read-oriented: it waits for the already-committed question and does not create another one. For a WSL process that received compatibility proof at launch, use the printed executable `omni-ide` WSL resume command so the same distro and packaged launcher authority are preserved; do not substitute a PATH-resolved local CLI. Older WSL processes that never received the hidden launch token remain lifecycle read-only after the update, even while their terminal and filesystem work continue.

Legacy inspection remains available without consuming mail:

```bash
omni orchestration run-list --json
# run_legacy_local is an empty audit tombstone after adoption.
omni orchestration run-show --id run_legacy_local --json
# In run-list, find the ordinary Run whose objective is:
# "Recovered orchestration work from a contract update"
omni orchestration run-show --id <adopted_run_id> --json
omni orchestration task-list --run <adopted_run_id> --json
omni orchestration inbox --full --json
omni orchestration check --terminal <legacy_handle> --peek --format --json
omni terminal read --terminal <legacy_handle> --json
omni terminal wait --terminal <legacy_handle> --for tui-idle --timeout-ms 60000 --json
```

If the original coordinator is unavailable or cannot prove its retained authority, a current coordinator may explicitly take over the adopted Run from its own live agent terminal:

```bash
omni orchestration run-use --id <adopted_run_id> --takeover-legacy --json
omni orchestration check --run <adopted_run_id> --json
```

Takeover fences only the old coordinator, binds the current one, and moves pending worker mail into current Run Delivery. It is bound to the authenticated invoking terminal; `--from` cannot name another coordinator. Live legacy workers keep their original Tasks, Dispatches, processes, filesystems, and old prompt commands; their later questions, escalations, and completion reports route to the current coordinator. Do not use takeover while the original coordinator is still actively coordinating, because its later lifecycle mutations are rejected.

Do not launch a replacement editor merely because the desktop app or runtime was updated. If adoption cannot prove continuing authority, keep the original worker as the only editor until it reaches a stable handoff point, then use a new current Dispatch in a conflict-free placement for any remaining work.

## Ownership

New orchestration messages and tasks belong to one explicitly bound Run. A Run is only a durable namespace and coordinator inbox; it never schedules or places workers. Lifecycle authority comes from the active Dispatch, and terminal handles remain routing metadata rather than durable identity. Send `worker_done` and `heartbeat` from the worker's own terminal; Orca routes them to that Dispatch's Run.

Classify inherited context before sending lifecycle messages:

- Coordinated subtask: a live coordinator owns the DAG and waits on this dispatch. Follow the preamble exactly, including `worker_done`, heartbeat/status, `ask`, and `escalation`.
- Full handoff means ownership transfer, not supervised dispatch. The original actor is not monitoring a DAG, so do not create lifecycle obligations unless the user explicitly asks you to supervise.
- Classify requests containing "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "another agent", or "another worktree" as full handoffs by default, even when the user names a custom model or reasoning effort.
- Use supervised orchestration only when the user explicitly asks you to "supervise", "monitor", "wait", "track completion", "wait for worker_done", return results, coordinate a DAG, use a decision gate, or manage ask/reply flow.
- Do not use `omni orchestration dispatch --inject` for full handoffs. It injects a coordinator preamble that tells the worker to send `worker_done`, heartbeat, and `ask` messages, then end its turn under the original terminal's dispatch lifecycle.
- Do not run `omni orchestration task-create`, `omni orchestration dispatch --inject`, or `omni orchestration check --wait` for full handoffs. Do not peek at terminal output after prompt delivery to monitor progress.
- A review-only `worker_done` reports findings; it does not authorize coordinator file edits. After a review-only completion, synthesize findings, ask a decision gate if ownership is unclear, and dispatch or hand off fixes unless the user explicitly asked the coordinator to own fixes.
- If the user's plan names a next owner agent (for example, "then use opencode to create a PR"), post-review corrections and PR prep belong to that named owner. The coordinator routes, synthesizes, asks decision gates when needed, and supervises; the named owner edits files and creates the PR.

If unclear, inspect orchestration state before sending lifecycle messages:

```bash
omni orchestration task-list --json
omni terminal list --json
# If inherited context includes a task id:
omni orchestration dispatch-show --task <task_id> --json
```

## Messaging

```bash
omni orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]
omni orchestration check [--terminal <handle>] [--ack <delivery_id>] [--peek|--all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--json]
omni orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]
omni orchestration ask (--question <text>|--resume <msg_id>) [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--json]
omni orchestration inbox [--limit <n>] [--json]
```

Rules:

- Omit `--from` unless impersonating another terminal; Orca auto-resolves it from the current terminal.
- A coordinator `check` returns the bound Run's oldest FIFO Delivery (up to 50 messages) and replays that exact batch until `--ack <delivery_id>`. Process every message before acknowledging; `check --ack <id> --wait` acknowledges, checks, and waits in one operation.
- Use `--peek` and `--all` only for read-only history/debugging. Type filters decide when a waiter wakes; the returned actionable Delivery is still the oldest full batch.
- Use `dispatch:<id>` for coordinator guidance to one supervised worker. Orca routes that stable address locally or through the connected-server relay; do not substitute a remote terminal handle.
- Terminal handles remain appropriate for low-level pre-Dispatch messaging. Prefer `agentTerminalHandle` from the create response, fall back to `startupTerminal.handle` for older runtimes, then re-resolve with `omni terminal list --worktree ... --json` if missing or stale. Continue with the replacement handle only; never dual-send to old and new handles.
- `terminal list --json` omits `visualLayouts` because handle recovery does not need topology. Add `--include-visual-layouts` only for explicit tab and pane inspection.
- `omni orchestration check --peek --format --json` returns locally formatted unread mail without consuming it; it never writes to terminal input or remotely wakes another terminal. Use `orchestration dispatch --inject` to deliver a tracked task, or `terminal send` when an existing agent needs a free-form prompt.
- While supervising workers manually, use `check --wait --types worker_done,escalation,question --timeout-ms <n>` instead of sleep/poll loops. Process the whole Delivery, reply to `question` messages with `omni orchestration reply --id <msg_id> --body <answer> --json`, then acknowledge and keep waiting.
- `check --json` prints exactly one JSON document on stdout. While `--wait` blocks it also prints keepalive lines (`{"_keepalive":true,...}`) to stderr so you can tell the process is alive; those are never on stdout. Do not merge the streams before a parser — `check --wait --json 2>&1 | <parser>` fails with "Extra data: line 2". Pipe stdout only.
- Treat a `check --wait` timeout or `{count:0}` as a checkpoint, not a worker failure. Long coding tasks routinely run 15-60 minutes; keep using rolling waits unless you receive `worker_done`/`escalation`, the terminal exits or disappears, or the user explicitly asks you to stop.
- Heartbeats and visible terminal activity mean the worker is alive, not done. Do not stop, close, kill, or restart a worker just because it has not produced a completion message yet.
- Use `ask` when a worker needs a blocking answer from the coordinator; it defaults to the active Dispatch's Run. Timeout or disconnect leaves the question pending, so resume by its original message ID instead of asking again.
- `check --wait` returns one bounded Delivery, not every future completion. Process every message, acknowledge it, then keep waiting until every expected Dispatch settles.
- Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`, `@cursor`, and `@worktree:<id>`.
- Message types include `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `question`, `decision_gate` (legacy/gates), and `heartbeat`.
- Use group addresses only for messages that are genuinely useful to many terminals, such as `status` broadcasts or intentional fan-out questions. Do not send dispatch lifecycle messages to groups.
- `worker_done` belongs to the active Dispatch and defaults to its Run mailbox; never target a group.
- A valid `worker_done` for the active `taskId` + `dispatchId` marks the task and dispatch completed automatically. Do not follow it with `task-update --status completed`; reserve manual updates for explicit recovery or overrides.
- `heartbeat` is also Dispatch-scoped. Include both IDs and omit `--to` so Orca uses the owning Run; use `status` for broad progress updates.

## Tasks And Dispatch

A Run is the namespace/inbox, a Task is the work item, and a Dispatch assigns one Task attempt to a terminal. Create or bind a Run once before the common loop.

```bash
omni orchestration run-create --objective <text> --json
omni orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>] [--json]
omni orchestration task-list [--status <status>] [--ready] [--brief] [--json]
omni orchestration task-update --id <task_id> --status <status> [--result <json>] [--json]
omni orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--inject] [--json]
omni orchestration dispatch-show --task <task_id> [--json]
```

Task statuses: `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`.

Dispatch rules:

- `--inject` sends the task spec plus preamble into a recognized agent CLI so it can report `worker_done`.
- If the target is a bare shell, omit `--inject`, dispatch for tracking if needed, then send the prompt manually with `omni terminal send --terminal <handle> --text <prompt> --enter --json`.
- After 3 consecutive failures on one task, the dispatch context circuit-breaks and the task is marked failed.
- Use `task-list --brief --json` for coordinator sweeps; it collapses whitespace and caps each echoed spec at 160 characters (`spec_truncated` marks shortened rows). Omit `--brief` when the full spec is required, or when an older CLI rejects it as an unknown flag.

## Production task templates

Every worker task is a contract by default: render its brief from a template instead of writing it free-hand. This is how a coordinator gives work — a Run's coordinator, a Project's coordinator, or any agent dispatching workers — for code and for any other work (research, ads, support, documents). Use a free-text `--spec` only for a quick read-only question whose answer you check yourself.

```bash
omni orchestration task-templates [--template <id>] [--json]
omni orchestration task-create --template implement --fields-file <fields.json> [--field key=value]... --json
omni orchestration task-create --template release --fields-file <fields.json> --print-spec
```

The templates are `implement`, `verify`, `independent-review`, `deterministic-qa`, `release` and `live-verification`. Every one requires `objective`, `owner`, `host`, `branch`, `scope`, `acceptance` and `evidence`. A missing or placeholder field is refused and no Task is created; `--print-spec` renders the brief and creates nothing; a `--field` wins over the file. Write `acceptance` one check per line: the brief numbers them A1, A2, … and the worker reports one `A1 PASS|FAIL — …` line per item in its `worker_done` body.

- An `implement` Task gets a `verify` Task that waits on it, by default: the same Acceptance lines, re-run read-only by a worker who did not write the work (`--no-verify` skips it). Dispatch it to a different worker, and accept the implement Task only on its pass. The worker's report is a claim, not evidence.
- Not coordinating a Run? `omni session launch --provider claude|codex --contract <fields.json>` takes the same `implement` fields from any terminal (Claude, Codex, Omnigent, a shell), renders the brief from them and binds its Acceptance lines to a verify step on the session.
- When `verify` reports FAIL lines, send them to the implementer exactly as the verifier wrote them (`send --to dispatch:<id> --body "<the FAIL lines, unchanged>"`, or a retry Dispatch whose spec quotes them). Never paraphrase them or add your own diagnosis: a coordinator's rewritten fix instruction is how a fixable failure stays broken.

- Run the stages in that order and add `independent-review` only when a reason justifies it. Creating an `implement` Task names the guard families its brief touches (auth, permissions, cross-host, money, migration, destructive); those need a review. The reviewer is a different model family than the author and stays read-only.
- `deterministic-qa` runs exact commands and reports host, exit code and output. `release` is refused without an `approval` that names this release and a `rollback`. `live-verification` checks the running system: a launch receipt, exit 0, HTTP 200 or a merged PR is not verified success.
- A template shapes the brief only. It never dispatches, approves, accepts or releases, and every rendered brief repeats the human-approval boundaries.

### Before an Opus verifier (Workflow-tool Verify phase)

Check each finding mechanically before a Verify phase spends an Opus verifier on it. Every cited path must exist in the target repo at the run's commit, and every line or range must be inside its file. The quoted code must be in the file, whitespace ignored. A claim that something is absent ("not wired", "never called", "missing", "does not exist") must carry the `rg` search behind it; re-run it, and treat any match as a flag. Drop a finding only when none of its citations resolves, and log why. Pass everything else on with the check's report, flags included, for the verifier to weigh. Discover runs this check itself before its reviewers when the run can read its workspace (not Knowledge only), and counts drops and flags in the run result (`results.preVerify`).

## Shared facts (FACTS.md)

When several sessions each work on one part of a goal, the coordinator keeps one `FACTS.md` in the shared task folder (for example `~/Work/Ops/Projects/<task>/FACTS.md`). It holds:

- One line: several sessions, each owning one part. Stay inside your part.
- A table of Session title | Owns | Brief path.
- `## Facts gathered so far (<date>; check before relying on them)`, each fact with its source (Slite id, path, command or PR).
- The rules every session follows (read-only limits, approvals, credentials).

Workers read it before starting and send new facts to the coordinator, who adds them with their source. Share facts, not conclusions or chat, so each investigator's mistakes stay independent. It is not a task list or an approval record: Tasks stay in the Run and approvals stay with the person.

## Run queue

One bounded read of where a Run's unfinished Tasks stand:

```bash
omni orchestration run-show --id <run_id> --queue [--limit <n>] --json
```

Each row has the Task, its newest Dispatch and, apart from it, what the worker's session shows now. The Dispatch record and the session are separate facts and can disagree. Rows are labelled `not-started`, `blocked`, `starting`, `working`, `quiet`, `waiting-on-human`, `waiting-on-coordinator`, `provider-limited`, `idle-unreported`, `unverifiable`, `exited-unreported`, `outcome-unknown`, `failed` or `failed-session-live`.

- `quiet` and `unverifiable` are not exits. Keep the worker and read it with `worker-read`.
- `failed-session-live` is a Dispatch that failed (for example `input_accepted_stalled`) while its session is still live. Do not start a second editor beside it: read it, then retry onto the same terminal with `worker-start --task <task_id> --retry-of <id> --terminal <handle> --worktree <selector>`, or release it.
- `idle-unreported` and `exited-unreported` need your decision through `worker-show`; nothing was retried or stopped for you.

The read reconciles, stops, retries and releases nothing. It needs `orchestration.run-queue.v1`; on an older runtime use `task-list --run <run_id>` and `worker-show`.

## How deep workers can nest

A dispatched worker normally cannot dispatch sub-workers. Attempting it fails with
`nested_worker_depth_exceeded` and a message telling the worker to complete the task
itself. Do that — do not try to route around it.

The limit is a number, not an on/off switch. `Settings -> Orchestration -> Nested worker depth`
sets how many generations are allowed:

- `1` (default): a coordinator dispatches workers; those workers do not dispatch.
- `2`: workers may dispatch one further generation.

Depth is counted from the terminal that issues the command, not from the Run. Creating a
new Run does not reset it — a worker that runs `run-create` then `worker-start` is still a
worker, and still counted. This is the part that changed: the old behaviour rejected
sub-dispatch only because a worker's terminal was not bound to a Run, so creating a Run was
enough to slip past it.

Two limits worth knowing:

- **It is a guardrail, not a security boundary.** A caller that declares another terminal's
  handle while its own launch evidence is unverifiable (an ordinary restored terminal, for
  example) can be counted as that terminal instead. Orca does not treat workers as hostile.
- **It applies while a Dispatch is active.** After `worker_done`, or after a coordinator
  settles the task, the terminal is no longer a worker and is counted as a root again. The
  process may still be alive; that is the documented boundary, not an accident.

## Preferred Supervised Worker Loop

Use `worker-start` for the normal supervised path. It composes the existing worktree, terminal, readiness, and dispatch primitives while returning exact created/reused effects. Agents still choose placement and concurrency; Orca does not schedule workers or infer conflicts.

For unsupervised agents use `omni session launch`, which picks a verified account on the host (see **Launch an agent** in the omni-cli skill). With no coordinator to check the result, pass `--contract <fields.json>` (the `implement` fields) so the session gets a verify step of its own.

Choose the lifetime before launching. Newly created local Claude/Codex workers default to
accepted-completion cleanup when the owner supports it and the worker and coordinator have no
protection hold. Use `--keep-as-conversation` to opt out, or `--close-on-completion` to require
the policy and receive an error if it cannot be applied. Acknowledging an accepted `worker_done`
Delivery requests cleanup. Decide whether to reuse or Keep the worker **before** acknowledging.
Acknowledgment durably requests cleanup. Open questions, unread mail, active descendant Tasks
and active native children temporarily hold it; the owner retries after those obligations
settle. Explicit Keep, user takeover, protection and unproven identity continue to retain the
worker. Generic, remote, reused, and unsupported launches remain retained.

Before acknowledging, read the result and verify the required deliverable is accessible at
its stated destination. A remote path without a completed transfer is not a delivered file.
Use the existing Task Contract for required outputs, verification and business acceptance;
local `worker_done` and acknowledgment settle only the execution attempt. A failed attempt
can be released after its evidence and remaining work have been accepted by the parent;
this never marks the business task successful or authorizes a retry over a live writer.

Substantive delegated work defaults to a durable file/artifact: implementation files,
research findings, test evidence or a handoff report in the assigned workspace. Reuse an
existing required format, commit or deliverable instead of producing redundant reports.
Name the result with `--report-path`, identify its execution host, and keep a concise summary
in `--body`. Communication probes and small internal answers entirely contained in the
durable result message may omit a separate file with a reason. Required contract artifacts
never use that exception. The transcript archive is recovery evidence, not the deliverable.

Create the Run and every independent Task first, then start all independent workers before waiting:

```bash
omni orchestration run-create --objective "<objective>" --json
omni orchestration task-create --spec "<worker A task>" --json
omni orchestration task-create --spec "<worker B task>" --json
omni orchestration worker-start --task <task_a> --worktree current --agent codex --close-on-completion --json
omni orchestration worker-start --task <task_b> --worktree current --agent claude --close-on-completion --json
```

`current` and exact existing worktrees create a fresh agent terminal and do not rerun setup. Reuse an existing agent only with `--terminal <handle>`.

For a per-invocation Claude, Codex, or Cursor launch, pass an opaque provider model id with `--model`; add `--effort` only when that agent/model supports the level. These options apply only to fresh agent terminals, override general agent default arguments, and are reported under `launch.requested` and `launch.effective` in the receipt:

```bash
omni orchestration worker-start --task <task_id> --worktree current --close-on-completion --agent claude --model opus --effort high --json
```

`--effort` requires `--model`, and neither option can combine with `--terminal`. A connected worker server must advertise launch-preference support before Orca forwards either option.

For a new worktree, setup runs by default and agent-first creation reuses the returned startup agent terminal:

```bash
omni orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --close-on-completion --json
# Independent/top-level:
omni orchestration worker-start --task <task_id> --worktree new-top-level --name <name> --agent codex --setup run --close-on-completion --json
```

Setup normally starts alongside the agent. Only a repository explicitly configured with `wait-for-setup` delays agent launch until setup succeeds. Use `--setup skip` or `--setup inherit` only for a concrete reason.

Read the returned receipt before continuing: `ready` plus setup `running` is normal for start-immediately, while wait-for-setup returns setup `succeeded` before accepting task input. A failed or unknown start exits nonzero; inspect its `stage`, `effects`, and `residualResources` instead of guessing or automatically retrying. A wait-for-setup timeout can honestly leave setup `running`, which is not proof of failure.

To run the worker on another connected Orca server, add `--on <saved-environment>`. The Run and Tasks remain authoritative on the current server; later commands route by Dispatch ID, so never repeat `--on`:

```bash
# Mac Run home -> Windows worker (the reverse is identical from a Windows Run home)
omni orchestration worker-start --task <task_id> --on windows --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent codex --setup run --json
omni orchestration worker-show --dispatch <dispatch_id> --json
omni orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
omni orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<attempt-specific guidance>" --json
```

Remote `current` and `new-child` are intentionally invalid because those words are ambiguous across servers. Use an exact discovered remote worktree selector or `new-top-level` with an explicit remote repo selector.

A worker joins its coordinator's project when the coordinator is one of that project's threads (filed in its folder, its project chat, or a worker one of those started). Its task then arrives after the project line and the project's context, resolved for the computer it runs on, and the receipt's `project` names it, with `notOnHost` for items that computer lacks. To send a worker into a project from outside it, add `--project <folder>` (a Conversations folder in the project, by id or path); Orca files the worker there. `--no-project` starts it without one. A worker started with `--on` gets the same project line and context in its task text, resolved for that computer; its terminal lives there, so it is not filed here.

The follow-up is structured inbox mail, not prompt injection. The worker's next
`orchestration check` receives it even when the Dispatch is on another connected Orca server.

`worker-read` defaults to `--source auto`: Orca returns the exact hook-reported Codex, Claude, OpenClaude, or Grok transcript when it can prove the worker session, otherwise it returns bounded terminal output with `source: "terminal"` and a typed `fallbackReason`. Continue with the returned top-level `cursor`; it stays pinned to that exact source. If Orca reports `source_changed`, start a fresh read without the old cursor. Never supply or guess a provider session ID or transcript path.

Wait until every expected Dispatch settles, not for a fixed number of batches:

```bash
omni orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
# Process every message. Reuse or Keep a worker before acknowledging its worker_done.
# The acknowledgment requests exact release for an eligible finite worker:
omni orchestration check --ack <delivery_id> --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

After processing each accepted `worker_done`, choose the terminal's next owner before you acknowledge the Delivery or wait again. If the same exact agent has an immediate follow-up Task, read the `worker.agent_terminal_handle` field of `worker-show --dispatch <dispatch_id> --json`, then run `omni orchestration worker-start --task <next_task_id> --terminal <handle> --json` so Orca transfers cleanup ownership to the new Dispatch. To keep it as a conversation, run `omni orchestration worker-retain --dispatch <dispatch_id> --json` before acknowledgment. For legacy or opted-out workers without the policy, run `worker-release` explicitly when cleanup is wanted.

Release is post-completion cleanup, not cancellation: Orca first preserves inspectable output, then closes only the exact agent terminal owned by that settled Dispatch. Reused or pre-existing terminals, setup terminals, coordinators, active workers, user-taken-over terminals, and identities Orca cannot prove are retained. When the user is finished with a retained worker, the same Dispatch can be passed to `worker-release`, which clears the requested retention and releases the terminal.

Do not release a worker because of a timeout, TUI idle state, heartbeat, status, question, escalation, or rejected/stale `worker_done`. If release returns `release_pending` or `release_unknown`, do not substitute `terminal close`; follow the exact recovery action in the receipt. A replayed Delivery may repeat `worker-release` safely.

Workers report exactly once using the IDs and capability injected by Orca; they do not supply Run/server/terminal identity:

```bash
omni orchestration send --type worker_done --subject "<status>" --body "<what changed, findings, and what remains>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a,path/b" --json
# On failure, use --outcome failed; never encode failure only in prose.
```

A worker question defaults to its owning Run. Timeout leaves it pending:

```bash
omni orchestration ask --question "<question>" --options "yes,no" --timeout-ms 600000 --json
omni orchestration ask --resume <message_id> --timeout-ms 600000 --json
# Coordinator:
omni orchestration reply --id <message_id> --body "<answer>" --json
```

Recovery is conditional, never a fixed destructive sequence:

- The response was lost and named no Dispatch: run `omni orchestration request-show --request <request_id> --json` first. It is read-only. `completed` means the mutation already took effect. `pending` means the original mutation is still running or Orca restarted before recording its outcome. For either state, replaying the original command with `--retry-request <request_id>` reuses the same operation identity so Orca can replay, join, or safely recover it without starting a separate duplicate. `absent` means this runtime holds no receipt under your caller identity and is not proof that nothing happened; inspect the affected state before deciding whether to retry.
- `worker-show --dispatch <id>` says `ready`: keep waiting or read bounded output.
- It proves `failed` or `stopped`: start a replacement with `worker-start --task <task> --retry-of <id>` plus an explicit `--on`/`--worktree` and `--agent`/`--terminal` choice. Retry does not silently inherit placement.
- It remains `outcome_unknown`: either `worker-stop --dispatch <id>` and inspect again, or explicitly `worker-abandon --dispatch <id>` while accepting that resources may still be live. Abandon performs no remote, process, or filesystem action.
- `worker-stop` closes only the exact supervised agent terminal. It never deletes the worktree, setup terminal, configured tabs, or unrelated processes.

Low-level `worktree create`, `terminal create`, and `dispatch --inject` remain valid recipes for custom argv or topology that `worker-start` does not express.

`dispatch --inject` deliberately keeps an operator-started terminal unsupervised: it never creates a `worker_dispatches` row and `worker-stop`/`worker-abandon` never close that process. The dispatch context is still authoritative, so `worker-show`, `worker-read`, and `worker-list` report it as `unsupervised`; settled `worker-retain` and `worker-release` report `retained` with `no_owned_resource` and take no process action. Use `worker-start --terminal <handle>` when supervision and worker lifecycle state are required.

## Disposable workers

For a new local Claude or Codex worker whose terminal should close after the coordinator accepts
its completed output, use `worker-start --close-on-completion`. The runtime must
advertise `orchestration.worker-completion-policy.v1`; an older host refuses the
flag. This is a launch-time choice: supported new local workers default to the
policy, while `--keep-as-conversation` opts out. Existing and unsupported workers
keep manual release, and `--on` or `--terminal` cannot explicitly opt in.

The owner checks protected workspace and session identities, routines, pinned and
saved conversations at launch and again before release. A malformed or unreadable
protection setting refuses automatic cleanup; an absent idle-cleanup setting adds
no protected paths. An explicitly disposable
new worker may complete today; this exception does not change ordinary sessions'
started-today protection. Persistent email and routine owners stay protected.

Read and process every final report before acknowledging its delivery. For an
opted-in worker, acknowledgment durably requests release; self-reporting or merely
reading output never does. Immediate reuse or explicit retention before acceptance
keeps the terminal. Workers still send `worker_done` and then idle; they never
close themselves. Saved output and any exact provider resume manifest remain
available through `worker-read` after release. Failed or unverified owner cleanup
stays pending for recovery; it does not authorize a broad terminal close.

Verify the launch with `worker-show --dispatch <id> --json`: the persisted
`worker.startOptions.completionPolicy.kind` must be `release_on_accepted_completion`.
After accepting the final report, verify `terminalResource.releaseState` is `released`.
A completed Task alone proves neither policy installation nor process exit. Report any
pending or retained resource with its reason instead of calling it closed.

## Gates And Legacy Inspection

```bash
omni orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--json]
omni orchestration gate-resolve --id <gate_id> --resolution <text> [--json]
omni orchestration gate-list [--task <task_id>] [--status <status>] [--json]
```

Use `ask` for worker-to-coordinator questions; it creates a `question` message that the coordinator answers with `reply`. Use `gate-create` only for coordinator-managed task DAG decisions, not for answering a worker's `ask`.

`coordinator-start`, `coordinator-stop`, `run`, and `run-stop` are retired scheduler commands. They perform no effects and return the current-skill recovery action. They are not aliases for lightweight Run creation or binding.

Recovery only: `omni orchestration reset --tasks|--messages|--all --json` clears the selected local orchestration database state. Do not run it during active coordination unless explicitly abandoning that state.

## Full Handoffs

For full ownership transfer, start the new owner with `omni session launch` (or send to an existing terminal) and then stop monitoring unless the user asks for supervision.

Treat these as full handoff requests by default: "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "send this to another agent", "another agent", "another worktree", or "launch another agent to own this." Custom model or reasoning effort words such as `gpt-5.5`, `high`, or `xhigh` do not make the handoff supervised.

Supervised orchestration remains available only when the user explicitly asks for supervision or coordination: "supervise", "monitor", "wait for worker_done", "wait for results", "track completion", "DAG", "decision gate", "ask/reply", or "coordinate workers."

Do not run `omni orchestration task-create`, `omni orchestration dispatch --inject`, or `omni orchestration check --wait` for full handoffs. `task-create` is also forbidden because it records coordinator-owned tracking state; if a task row is needed, the user asked for supervised orchestration. Do not create a `taskId`/`dispatchId`, inject a lifecycle preamble, wait for completion, or read the worker terminal after prompt delivery except to avoid losing the initial prompt.

Launch the new owner with **Launch an agent** from the omni-cli skill (`omni skills get omni-cli`). Its first lines:

1. `omni session find-owner --task "<the task>" --json`. If `launchNew` is false, follow `disposition`. If it is true, run its `recommend`, an `omni session launch` command, after filling in its placeholders: the provider for `<claude|codex>` and your brief file for `<brief.md>` (write the brief to a file first). A `--project <id>` in it starts the agent in a fresh worktree from the repo default base; drop it to launch in this workspace when the work needs your branch or local changes.
2. Need a separate checkout? `omni worktree create --name <task> --no-parent --json` (no `--agent`), then pass `--worktree id:<worktree.id>` in place of any `--project <id>`; the launch refuses the two together.
3. Write the brief to a file and run `omni session launch --provider claude|codex --prompt-file <brief.md> [--worktree <selector>] [--host "<computer>"] [--model <m> --effort <e>] --json`. That computer picks the account with the most fresh verified capacity. Not sure which computer? `omni host list --capacity --provider <p> [--project <id>]` shows every computer's fresh account headroom and load; or pass `--project <id>` and the command picks the computer and account. `<id>` is a `github:<owner>/<repo>` id or a name from `omni project list`. For a git project it starts a fresh worktree from the repo default base: your branch and uncommitted or unpushed work do not travel, and its setup script runs beside the agent (a repository whose setup must finish first is refused with `launch_setup_first`; use the worktree-create command it prints). Use it only for work that starts from the default branch, never with `--worktree`. Unsure whether it started? Run the exact same command again, without `--again` if you added it; it never starts a second session.

New top-level worktree handoff:

```bash
omni worktree create --name <task-name> --no-parent --setup run --json
omni session launch --provider codex --worktree id:<newFullWorktreeId> --prompt-file <brief.md> --json
```

If the repository's omni.yaml sets `setupAgentStartupPolicy: wait-for-setup`, `session launch` does not wait for the new worktree's setup; there use `omni worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --setup run --json`, which sequences setup but does not verify account capacity.

Before creating a new worktree from an active feature branch, decide and state whether the desired Orca lineage is child or top-level. Use child worktree lineage only when the new work is conceptually stacked under or dependent on the active worktree. For independent repo-wide fixes, standalone feature work, or unrelated follow-up tasks, create a top-level worktree with `--no-parent`.

Existing terminal handoff:

```bash
omni terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Custom model/effort handoff: when the user asks for a specific model or effort, pass them to `session launch`. Never build `terminal create --command '<agent> --model …'` and then send the prompt.

Use the exact full `<repo-id>::<path>` worktree id returned by `omni worktree create --json`; a bare repo id cannot target the new worktree.

```bash
omni worktree create --name <task-name> --no-parent --setup run --json
omni session launch --worktree id:<newFullWorktreeId> --provider codex --model gpt-5.5 --effort xhigh --prompt-file <brief.md> --json
```

The receipt reports the computer, account and the model and effort that took effect; tell the person, then stop. Do not monitor task completion.

`--no-parent` only controls Orca lineage; it does not choose the Git base. If the work should start from the repo default base, omit `--base-branch` so Orca uses that default, or explicitly pass the repo default base (`origin/main`, `origin/master`, or the `omni repo show --repo <selector> --json` value); never base it on the current feature branch unless the user explicitly asks for stacked work or "branch from current". Put current-branch context in the prompt instead.

## Worker Terminals

Choose the worker location before creating a terminal. `Fresh worker` means a fresh agent session, not a new git worktree. For parallel work, create one fresh agent terminal per worker in the same required worktree, falling back to the active worktree when none is named. If the task says current worktree only, depends on uncommitted files/artifacts, or must validate/PR the current branch, keep every worker in the active worktree:

```bash
omni terminal create --worktree active --title <task-name> --command "codex" --json
omni terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
omni orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Reuse an idle agent in the required worktree only if the prompt allows reuse; otherwise create a fresh terminal there. Create a new worktree only when the user explicitly requests one or a concrete checkout or filesystem conflict makes sharing unsafe or impossible; if the user did not request it, state that conflict before running `worktree create`. Independent tasks, parallel execution, convenience, or a preference for separate checkouts are not isolation requirements.

When a new worktree is allowed, use child lineage for isolated work that is stacked under or dependent on the active worktree, and use `--no-parent` when it is not stacked. Decide the Git base separately: `--no-parent` makes the worktree top-level in Orca, while omitted `--base-branch` uses the repo default base.

For every new worktree, pass `--setup run` so any configured repository setup hook runs. This does not mean waiting for setup before agent launch: preserve the repository's startup policy, whose default starts setup and the agent side by side. Use `--setup skip` or `--setup inherit` only when there is a concrete task-specific reason, and state that reason before creating the worktree. This rule does not rerun setup for current or existing worktrees.

```bash
omni worktree create --name <task-name> --agent codex --setup run --json
# or: --agent claude | omp | pi | grok | ...
# Read <handle> from agentTerminalHandle, falling back to startupTerminal.handle.
omni terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
omni orchestration dispatch --task <task_id> --to <handle> --inject --json
```

For new-worktree workers, read the id and `agentTerminalHandle` from `worktree create`, falling back to `startupTerminal.handle` for older runtimes. Use that as the sole worker handle when present; otherwise use `terminal list` to resolve the agent handle. Omit `--repo` only inside an Orca-managed worktree; otherwise pass `--repo <selector>`.

**For an allowed new worktree, use agent-first:** `--agent` reveals the new worktree and launches the selected agent **in its first terminal**, without adding a separate fallback shell for that worker. Pass `--setup run`; repo setup and default-terminal settings may add intentional tabs or splits. Do **not** run bare `worktree create` and then `terminal create --command <agent>` for the same worker when agent-first create is available: without configured default tabs, that two-step path leaves a fallback shell + agent pair. Model and effort are not custom argv: pass `--model`/`--effort` to `worker-start` for a supervised worker, or `omni session launch --model … --effort …` (**Launch an agent** in the omni-cli skill) for an unsupervised one. Only use the two-step for argv neither accepts, or when an older CLI rejects `--agent`; if you must, message only the agent handle. Configured default tabs are intentional surfaces, so close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell. Do not run `worktree create` when the task must stay in the current worktree.

Use `omni worktree create --prompt ...` or `omni terminal send ...` for full handoffs or untracked/lightweight prompts. Those paths do not attach `taskId`/`dispatchId`; the worker should not send lifecycle messages unless the prompt supplies a live orchestration preamble.

Sidebar lineage and orchestration lifecycle are related but not identical. A same-worktree worker may appear as a peer under that worktree in the sidebar while remaining a child dispatch in orchestration state; only an actual child worktree creates visible parent/child worktree lineage.

Other terminal commands coordinators often need:

```bash
omni terminal list [--worktree <selector>] [--include-visual-layouts] [--json]
omni terminal create [--worktree <selector>] [--title <text>] [--command <cmd>] [--json]
omni terminal split --terminal <handle> [--direction horizontal|vertical] [--command <cmd>] [--json]
omni terminal wait --terminal <handle> --for tui-idle --timeout-ms <n> --json
omni terminal read --terminal <handle> --json
omni terminal send --terminal <handle> --text <text> --enter --json
```

If an older CLI rejects `worktree create --agent` for a supervised worker, create the worktree normally, then run `omni terminal create --worktree <selector> --command "codex" --json` or `--command "claude"`, with no model/effort argv.

Wait for `tui-idle` before dispatching. Always pass `--timeout-ms`; real coding tasks can take 15-60 minutes. During supervision, use rolling `check --wait` windows. If a window returns no matching message, inspect `task-list`, `terminal read`, or `terminal wait --for tui-idle` as a liveness checkpoint; if the terminal is still working or producing activity, keep waiting instead of retrying the task.

## Agent Guidance

- Workers with a valid live preamble must send `worker_done` exactly once from their own terminal with an explicit `--outcome succeeded` or `--outcome failed`:
  `omni orchestration send --type worker_done --subject "<short status>" --body "<one A1 PASS|FAIL line per Acceptance item, or a 3-sentence summary when there are none>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a" --report-path "<optional>" --json`
- A failed outcome is still a terminal report, but Orca records both the Dispatch and Task as failed. Never encode failure only in the subject/body.
- After sending `worker_done`, end that dispatched turn and idle at the agent prompt. Do not autonomously start more work, poll, or attempt to close the terminal yourself. A direct user instruction takes precedence and starts ordinary user-owned work: follow it without coordinator approval or a fresh Dispatch, never refuse it because of worker/coordinator roles, and do not reuse the settled Dispatch's lifecycle IDs. A coordinator-supervised follow-up still arrives with a fresh preamble + TASK block.
- For long tasks, send heartbeat/status only when the preamble asks for it, including both IDs:
  `omni orchestration send --type heartbeat --subject "alive" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","phase":"implementing"}' --json`
- If blocked before completion, use `ask`; use `escalation` only when ownership is valid and the coordinator must intervene.
- Treat preambles inherited through terminal history or full handoffs as stale unless the current prompt explicitly keeps that coordinator in the loop.
- Coordinators must account for every settled worker terminal before acknowledging its `worker_done` Delivery: reuse the exact worker for a new Dispatch, explicitly retain it with `worker-retain`, or let acknowledgment request finite-worker cleanup. Do not leave a completed worker live merely to inspect output; released workers remain readable through `worker-read`.
- Coordinators should use `task-list --ready` as external memory, dispatch parallel waves, and avoid dependency chains deeper than 3-4 steps.

## Example

```bash
omni terminal create --worktree active --title login-css-worker --command "claude" --json
omni terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
omni orchestration task-create --spec "Fix the login button CSS" --json
omni orchestration dispatch --task <task_id> --to <handle> --inject --json
omni orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

## Next Action

Coordinator: confirm `omni status --json`, create or bind a Run, inspect `task-list`/`dispatch-show` if inheriting state, then use the explicit supervised loop (`task-create` -> `worker-start` -> `check --wait`). Use low-level terminal creation plus `dispatch --inject` only when the composed start does not express the needed topology. After every accepted `worker_done`, transfer or retain an exact terminal before acknowledging if it must remain live. Acknowledgment requests release of an eligible finite worker.

Worker: if the current prompt contains a live dispatch preamble, do the task, use `ask` for blocking questions, and send `worker_done` once with the required payload. If the preamble is stale or absent, do not send lifecycle messages; inspect state or treat the prompt as an ordinary handoff.
