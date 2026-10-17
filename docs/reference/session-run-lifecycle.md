# Session run lifecycle: completion, recovery and human attention

One policy decides what a pursued session (a `SessionChain` with an `outcomeSet`) is doing, when it is
finished, and when it may interrupt a person. Every writer and every projection reads it; nothing
derives "needs you" on its own. The policy extends the existing outcome host (`SessionOutcomeService`
tick, attempts, receipts, `resumeSessionOutcomeWork`) — it is not a second state machine.

## The concepts, kept apart

| Concept                         | Carrier                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run and generation              | the chain; a later Outcome on a finished run forks `source_<sha>_<n>` (`forkFinishedOutcomeSource`), and `planVersion` separates strategies inside one run |
| Outcome and completion evidence | `outcomeSet.outcomes[]`, receipts at the current `outcome.revision`                                                                                        |
| Worker attempt                  | `outcomeSet.attempts[]` (`failure.at`, `awaiting`)                                                                                                         |
| Ordered stages                  | `chain.steps` + `outcomeSet.completedSteps`                                                                                                                |
| Successor work                  | a forked chain, or an Up next continuation held behind a person review of this run (`outcomeSet.heldContinuation`)                                         |
| Human-attention request         | `outcomeSet.attention[]`                                                                                                                                   |
| Successful disposition          | `outcomeSet.completion` (the seal) + `outcomeSet.disposition`                                                                                              |

## Phases (`readSessionRun`, `src/shared/session-run-lifecycle.ts`)

`active` · `recovering` · `waiting` · `needs-you` · `failed` · `completed`, evaluated in this order:

1. `completed` — the set carries a `completion` seal, or every outcome is satisfied on an owned host
   and none of its own person reviews holds it (below). A proven run with held work is
   `active` (the host hands a reviewer's notes to the agent, or starts the held work), `recovering`
   while the host is refused, and `failed` once a release has stood for `SESSION_RECOVERING_MAX_MS` or
   the notes could not be handed over — never `completed`, never `needs-you`. An unfinished run whose
   agent is fixing what a reviewer asked for is `active`.
2. `needs-you` — at least one VALID, OPEN attention request addressed to the owner.
3. `active` — an outcome is running, or is pending with nothing failed in front of it.
4. `recovering` — a block of class `recovering`: bounded automatic recovery is in progress.
5. `waiting` — a block of class `waiting` (a registered wake: evidence poll, a named person's reply,
   capacity, an unverifiable host that may reconnect), or a request addressed to someone else.
6. `failed` — a block of class `failed`, or a legacy/unclassified `blocked` outcome. An honest,
   machine-visible operational failure. Never needs-you.

The coarse `SessionOutcomeLifecycle` stays for existing callers: `completed → complete`,
`needs-you → needs-you`, everything else `waiting`. A blocked reason string is a DIAGNOSTIC (shown
under Details); it never decides the phase.

## Blocks are classified at the writer

`outcome.status === 'blocked'` keeps its free-text `blockedReason` and gains
`outcome.block = { class, code, since, until?, wake?, attentionIds? }`:

- `recovering` — the host will act again by itself (`until` = next action time).
- `waiting` — a real wake condition exists (`wake` names it).
- `attention` — one or more attention requests (`attentionIds`) are why this cannot continue.
- `failed` — recovery is exhausted or unsafe, and no human-only remedy exists.

A `blocked` outcome without `block` reads as `failed / unclassified`. A `recovering` block that is not
managed by the attempt ladder and has not cleared within `SESSION_RECOVERING_MAX_MS` escalates to
`failed` with the same code. That staleness is measured from the scheduled `until` (from `since`
when there is none): a long backoff that has only just come due is still the host's to act on. An
`attention` block whose request was answered reads `recovering` while the host re-derives it, and
`failed` after the same maximum.

## Human-attention requests (`src/shared/session-human-attention.ts`)

A request exists only for a requirement a person alone can meet, and it says so:
`{ id, kind, scope, ask, why, recipient, action?, source, state, openedAt, resolvedAt?, resolution?, notifiedAt? }`.

- `kind`: `clarification · decision · approval · permission · credential · review`.
- `scope`: `{ outcomeId, outcomeRevision, planVersion?, stepId?, attemptId?, conditionId? }`. A request
  is VALID only while its outcome exists at that revision and plan version and its attempt (when
  named) is still the current unsettled one. Invalid requests are ignored and then withdrawn.
- `recipient`: `{type:'owner'}` or `{type:'person', employeeId, name?}`. Another person's review is
  never the owner's Needs You.
- `action`: the direct way to resolve it (`open-conversation` with a pane, `review-outcome` with a
  condition, `open-up-next`, `sign-in`).
- Requests are DERIVED from an unmet requirement and RESOLVED when it is met (the reconciler closes
  them); opening a session resolves nothing. The id is stable per requirement, so a restart,
  reconnect or re-observation neither duplicates it nor notifies twice (`notifiedAt`).
- A pass OPENS the requests it needs first and reconciles second, so a requirement that is still
  unmet keeps its request (and its `openedAt` and `notifiedAt`) instead of being withdrawn and asked
  again. A request whose scope moved to a newer plan version or step follows it in place.

Sources of a genuine request: an agent's own question / permission prompt (hook `waiting`, `blocked`,
`permission`), a named person's review, reviewers' unresolved findings after the authorized rounds, a verification gate that failed with no repair route, a provider sign-in failure, a usage
wall that outlived its retries, a principal that must be restored, a provider approval prompt that
survived automatic remediation, a brief too large to send. Idle workers, missed heartbeats, crashes,
missing verdicts, transient tool errors and startup failures are NOT requests. Neither is the
**owner's own review** ("I have reviewed the result", Sal 2026-09-19): it is where finished work
GOES, not a question. Once every other criterion is proven the verifier records the review itself
(`done-for-review:<version>`), the run seals and the conversation sits in **Done** for the owner; an
explicit approval of those exact bytes (`user-review:<version>`) is still recordable, and a change
after the seal is still a new version. An outcome with no actions and no steps is finished by its
source conversation, so it is verified only while that conversation is idle NOW — the sticky
`continuation.sourceReady` alone never seals or asks (the agent sent back to work is still working).

## Recovery ladder (`src/shared/session-attempt-recovery.ts`, run by the tick)

On a stopped attempt, in order: (1) completion evidence already exists → settle it; (2) the worker is
live or intentionally waiting → keep observing; (3) the launch never started, or the worker is
provably dead (settled receipt) → relaunch through the existing `retryable` primitive, at most
`SESSION_RECOVERY_MAX_AUTO_RETRIES` times with `SESSION_RECOVERY_BACKOFF_MS`, and never for a failure
older than `SESSION_RECOVERY_DEADLINE_MS`; (4) an `unverifiable` worker is NEVER relaunched — it is
held for `SESSION_RECOVERY_UNVERIFIABLE_GRACE_MS` and then fails honestly; (5) a specific human-only
requirement → a request; (6) otherwise `failed`. A person's Resume is the same ladder with the bound,
the deadline and the backoff lifted. Exhausting retries is never, by itself, a human requirement.

Backoff runs from the attempt's `failure.at`, stamped once when it stopped; re-observing a stopped
attempt never moves that clock. Resume is the person's ANSWER to a sign-in failure or an oversized
brief — those raise their request at once and relaunch only on Resume — and it still needs the
safety proof: nothing is relaunched over a worker that may be running. `operator-closed` fails as
`cancelled` before the safety proof is asked for: the person closed it, so there is nothing to wait
out.

The same bounded ladder recovers what is not an attempt. A handoff that was not delivered is sent
again by the host with the same backoff, bound and deadline: under the SAME key when delivery is
unconfirmed (a replay cannot deliver twice), under a FRESH key when the hub refused it; after that
it is `failed / handoff-delivery`. A reviewer or gate that returned no readable verdict is asked
again within the same bound before the outcome reads `failed`; a missing verdict is never a request.

Source readiness never waits silently: a live source that has not finished its turn is a `waiting`
block with a code and a wake, never a tick that returns without a reason. A session receipt already
earned survives loss of contact: an inconclusive observation (an `unverifiable` pane or host, a
pane not yet quiet long enough to say) refuses new proof and revokes none, so only a definite
reading — the source ran again, asked, failed or changed — may spend the receipt and its review
evidence.

## Completion is sealed, disposition is separate

When every required stage and condition is proven, `service.save` stamps `completion` (time, outcome
revisions, plan version, receipt ids) in the same durable write that sets `chain.state = 'done'`.
A sealed run stays complete: late heartbeats, old-attempt events, stale snapshots, evidence drift,
an unowned host and failed successors cannot change it; verify/review/resume are no-ops on it. A
sealed set accepts only a commit that changes nothing or one that files its `taskRef`; any other
commit is refused (`SESSION_RUN_SEALED_ERROR`) and new work forks a new run.

### Work held behind a review belongs to the run

Blocks composed after a person Review are held in the Up next draft store, marked with the review
step they wait on (`held.reviewStepId`). That step is a step of one run, and the run is not over
while the work waits: `service.save` reads the draft store (`up-next-held-gates.ts`) and stamps
`heldContinuation = { reviewStepIds, since?, refused?, fixes? }` for as long as anything is held
behind one of its own reviews. On a set that would otherwise complete the stamp replaces the seal —
no `done`, no disposition. `since` (the stale clock) exists only while the set is otherwise
complete; `fixes` is kept by union across writers.

- **Release — only on every OK.** The held blocks are released only when EVERY named reviewer
  approved the current version (`upNextReviewSettled`): the host tick appends them to the SAME run
  (`resumeUpNextContinuations`, an `append` commit) with what the reviewers wrote in the released
  stages' instruction. "1 of 2 said OK" keeps them paused, and so does any "needs changes".
- **Needs changes — the agent fixes it, the same person is asked again.** Each `request_changes`
  reply becomes one fix record keyed by its receipt, with the reviewer's note and round
  (`up-next-review-fix.ts`, run by the tick in the run's own lane). Once every reviewer of the round
  has answered, their notes go to THIS conversation's own agent as one prompt — the prompt queue's
  own record through the person's own send door (`conversation-prompt-now.ts`), after the agent's
  last turn ended. When the next turn ends, each of those reviewers is asked again
  (`session-review-reask.ts`): same thread, delivery `pending`, round + 1, a fresh operation id,
  `rule.reask = true`, and a fresh capture that keeps the summary's name. Their old receipt moves to
  `evidenceHistory`; approvals from the others stay. Exactly once across ticks and restarts: the
  prompt id and the turn it follows are durable before the prompt is admitted, and a send a restart
  cannot account for is settled failed (`review-fix-failed`), never sent again.
- **Phase.** Waiting for a reply reads `waiting` (wake = the people). While the agent fixes the work,
  or the host releases the held blocks, the run reads `active`. A release (or a hand-over of the
  notes) the host is refused reads `recovering` (`continuation-refused`, the refusal under Details)
  and is asked again every pass; a release still not made after `SESSION_RECOVERING_MAX_MS` reads
  `failed` (`continuation-held`). Never `needs-you` for the sender, never `completed` while anything
  is held. The run completes and seals only after the released work is proven.
- A Hand off is terminal: nothing is held behind one, and it seals on its verified delivery as before.

**Every ticked Review is a gate, held work or not.** A person Review whose sender ticked "Wait for
their OK" (`sessionFollowUpDisposition === 'feedback'`) holds its run until every named person
approved the current work, also when nothing waits behind it (the last block): the one gate list
(`upNextHeldContinuation`) names each review of the current plan version that is still out
(`upNextReviewOpen`), so the stamp, the phases, the once-only fix prompt and the re-ask above are
the same. The last OK drops the gate, and a run with nothing left seals Completed through the
ordinary seal and disposition. A second ticked Review of the same person (Draft → Review → Improve →
Review, released into the same run) replaces the first ask (`session-review-ask.ts`): their one
condition is read only from the newest ask's own thread, an answer read from an older ask's thread
moves to `evidenceHistory` once, and the older ask gates nothing, reads as done in Up next
(`upNextReviewReplaced`) and never takes a later answer as its own. "Newest" is read among the
steps of the Outcome that owns the condition (`stepIds`): a Review of the same person that another
Outcome asks is that Outcome's own, and replaces nothing. A thread reply that is not a
review decision counts for nothing. A Hand off, a cancelled or quarantined run and a sealed run
hold nothing: a run an older build sealed on a "needs changes" reply stays sealed, and the audit
does not list it. A card-bound (`workflow`) run and a planning-source run are not gated by a review
with nothing held behind it: their tick does not hand the notes to the agent, so they seal on the
reply as before; work held behind their reviews still holds them.

A run a build sealed while its continuation was still held stays sealed. The audit reports it
(`sealed-with-held-continuation`) and the host releases the held work as a new run generation through
the ordinary fork (`forkFinishedOutcomeSource`), whatever the reviewers answered — that build already
consumed their replies.

`disposition = { intent, folderId?, state, operationId, attempts, lastError?, nextAttemptAt?, appliedAt? }`:

- no explicit terminal action (or legacy `me`) → `completed`, applied at the seal; nothing is closed;
- `Done → Close session` → `close`; `Done → Save session` → `save` (+ folder).

Close and save are window facts, so the renderer performs them and reports the result with the
`operationId` (`sessionChain.reportDisposition`). A failure leaves the work completed, is retried
with backoff a bounded number of times, and never reports Saved/Closed before it happened. Once
those retries run out (`state: 'failed'`) every surface still reads Completed, with a quiet "Could
not close this session · Try again" (`sessionChain.retryDisposition`: one more bounded series, same
operation) and `lastError` under Details. It is never Needs You and never a failure of the work.

## Reconciliation

The host tick is the reconciler. It runs at host start, on continuation hand-over, on worker exit,
on a renderer refresh (`service.reconcile`, sent on first contact and after a reconnect) and on the
2 s cadence; a commit needs no pass of its own because `save()` settles that commit's own record in
the same write. It runs headless. It repairs a persisted state that contradicts the record
(complete evidence under a non-done state, stale requests, a legacy blocked reason with no class),
never reopens cancelled or sealed runs, and `auditSessionRuns` lists stranded runs read-only before
anything is repaired — including a sealed run whose held continuation never ran
(`sealed-with-held-continuation`, released as a new generation).
