# Agent work lifecycle

Execution lifetime and human attention are separate. A result can remain reviewable
after its execution ends; an idle terminal alone does not prove either completion
or safe closure.

## Choose the smallest sufficient execution

| Work | Default | Why |
| --- | --- | --- |
| Bounded investigation, component, verification or internal answer owned by a live parent | Provider-native subagent, when supported | No additional OmniConsole conversation is needed. The parent collects results and owns unfinished children. |
| Independent provider/account/host/lifetime, or explicit dispatch/mailbox/recovery needs | Supervised finite worker | Exact Dispatch identity, delivery acknowledgement, resource ownership and archived output justify a separate execution. |
| Human-launched work, ongoing monitoring, explicit ownership handoff or retained debugging | Durable conversation | A person or independent owner needs to return to the conversation. |

Codex-to-Codex and Claude-to-Claude often fit the first row. Family alone does not
decide: native delegation must actually be available, and the child must not need
an independent lifetime. An isolated worktree alone does not require another session:
a native child can own that workspace within its parent's lifetime. Existing native
child rosters record provider activity without manufacturing another sidebar
conversation or Orca Dispatch.

Use the installed `omni-sessions`, `omni-cli` and `orchestration` guides and advertised
capabilities. Reuse an exact suitable idle owner; related work in a folder is not
automatically duplicate work. Preserve selected account, model, effort and host.

## Authorities and acceptance

The Hub Task Contract owns business scope, required artifacts, acceptance and
delegation constraints. OmniConsole consumes its task identity and revision; local
Runs and Tasks do not replace it. The Hub contract's raw `closed` transition does
not establish verified success: verification evidence and the admitted workflow's
outcome remain authoritative. A local Dispatch is one execution attempt and its
owned terminal is a resource, not the business task itself.

Local session Task Contracts (`session prep` / `session launch --contract`) are a
separate existing path: their acceptance criteria become WorkPlan verification and
finish gates. The plan now acknowledges a finite worker's exact result only after
the parent attempt is durably saved as completed. Restart reconciliation covers a
crash between save and acknowledgment, including sealed plans. This does not bypass
verification, consume unrelated questions or approvals, or accept Hub deliveries.

For new supported local Claude/Codex workers, `worker-start` defaults to finite
accepted-completion cleanup. `--close-on-completion` requires that capability;
`--keep-as-conversation` explicitly retains a conversation. Existing/adopted,
remote, unsupported-provider and Windows workers keep the established explicit
release path. Do not silently discard a capability or protection refusal.

The finite-worker flow is:

1. Dispatch exact work with acceptance criteria and a result destination.
2. Execute and save substantive results in the assigned workspace or required system.
3. Send `worker_done` with task/dispatch identities, outcome and result location.
4. The coordinator reads the delivered result, verifies access and required evidence,
   then acknowledges that exact delivery. `worker_done` alone cannot close execution.
5. Persist cleanup intent, wait for outstanding obligations, archive current output
   and exact resume identity, then close only the owned terminal and its owned helpers.
6. Mark released only after the execution owner proves exit. Keep the result,
   dispatch history, transcript and resume metadata after release.

Acknowledging a failed attempt accepts its failure report, not business completion.
The parent retains responsibility for recovery and retries. Never start an overlapping
writer because a host is unreachable or a previous attempt merely timed out.
Failed finite attempts use the same owned archive/release path before replacement;
missing inventory alone cannot prove that the original process or its helpers exited.

## Durable results by default

Use implementation files, findings, verification evidence or a handoff report.
Reuse the format and destination required by the Task Contract; an extra report is
unnecessary when the required artifact already contains the result. Put its path
in `worker_done.payload.reportPath` and identify its host when it is not local.
A path on an inaccessible host is not proof of delivery.

A trivial communication probe or small internal answer completely represented in
the durable result message may omit a separate file with an explicit reason. This
never waives a required contract artifact. The dispatch preamble and agent guides
establish this default; generic messaging remains compatible with these exceptions.
Archived session output is recovery evidence, not a substitute for a usable result.

## Holds and recovery

Unresolved questions, unread current-delivery messages, active descendant tasks,
and active native children or background work keep finite execution pending.
Accepted cleanup intent survives these temporary holds and is retried by the
existing host reconciliation loop. Explicit retention remains explicit retention.
Unread mail addressed to a settled Dispatch becomes visible in its parent Run's
existing Delivery without changing the original recipient, payload or message ID.
Peek and delivery alone keep the worker pending; parent acknowledgment of those
exact rows clears the mail hold. Active-worker mail stays with that worker.

Workspace/session protections, routines, saved or pinned work, human takeover,
identity changes, missing resume evidence and uncertain process state prevent
automatic closure. A terminal must not be killed to bypass a refusal. Same-day
finite-worker closure is separate from background idle cleanup.

Programmatic WorkPlan coordinator shells retain their stable pane identity for
recovery. They have no finite-worker resource contract; a completed child alone
does not authorize closing them.

Inspect `worker-show`, `worker-list`, `worker-read` and release receipts. `requested`,
`release_pending` and `release_unknown` do not mean exited. Reuse, explicit retention
or exact owned release resolve a worker; broad terminal/process kills do not.

## Human review after execution

A durable review needs both a discoverable decision and a tested continuation path.
An artifact review uses the existing review store, Work item, decision delivery and
provider resume machinery. Finite-worker release must preserve that relationship:
only an exact, armed review continuation can become asleep after confirmed exit.
Explicitly kept reviews and reviews without safe resume context keep execution open.
The output archive pins the review's account scope and revision before closing.
Decision delivery waits while closure is in flight; a failed sleep-state save remains
a recoverable release obligation instead of falsely reporting complete cleanup.

A Work row or a link to OmniOS, Work, Slite or a file is not by itself a resume
contract. Generic approvals, incomplete handoffs and unresolved execution obligations
remain open until their existing authority records a safe continuation. Human-owned
conversations do not become disposable merely because they published an artifact.
