# Session steward: actor, unattended context and switches

Phase 2 of the Session Focus Plan adds a third authority path: the app itself pressing Yes,
nudging, asking and archiving with no person present (decisions D3, D4, D5, D7). This page is
the foundation every steward feature builds on. Code: `src/shared/session-manage-types.ts`
(actor), `src/main/session-manage/session-manage-unattended.ts` (context and policy),
`src/main/session-manage/session-manage-unattended-admission.ts` (hooks the rules loop
provides), `src/shared/session-steward-settings.ts` and
`src/main/session-steward/steward-switches.ts` (switches).

## The steward actor

```ts
type SessionManageActor =
  | { kind: 'pane'; paneKey; title; unattended?: SessionManageUnattended }
  | { kind: 'cli'; unverifiedPaneKey?; unattended?: SessionManageUnattended }
  | { kind: 'steward'; feature: 'rules' | 'cleanup-run'; runId?: string }
  | { kind: 'steward'; feature: 'suggestion'; suggestionId: string }
```

- Title `Session steward`, so every prompt it sends starts `[from Session steward] ` and every
  question `[Question q-… from Session steward — answer only, change nothing] `. A pane or CLI
  actor carrying `unattended` reads the same way.
- Actor id (`requestedBy.actor`, decision logs): `steward`.
- Audit line: `actor: "steward"`, `steward: { feature, runId? }`. An unattended pane keeps its own
  `actor` and adds `unattended: { source, runId?, since? }`. `sessionActionActorKind` returns
  `steward` for both steward lines and `app/steward` organization lines, and
  `omni session actions --actor steward` filters on it.
- Organization executor: `{ kind: 'app', feature: 'steward' }` (`executorForActor`). It may
  establish placement ownership, never title ownership (`mayEstablishOwnership`).

**No caller can claim it.** `resolveSessionManageActor` only ever returns `pane` or `cli`; every
session-manage, folder and organize schema is strict, so an `actor`, `executor`, `steward` or
`unattended` field is refused; and the window's own record schema
(`OrganizationExecutorSchema`) accepts only `ORGANIZATION_WIRE_APP_FEATURES`, which leave
`steward` out. `session-steward-rpc-refusal.test.ts` walks every method that changes sessions.

## The unattended context

`SessionManageUnattended = { source: 'rules' | 'cleanup-run'; runId?; since? }`, written only by
main:

- The steward actor carries it by construction (`unattendedContextFor`).
- An automatic cleanup session's pane is registered: `registerUnattendedPane(paneKey, ctx)`
  returns the release. `setUnattendedPaneResolver(fn)` adds a durable source asked after the
  registry (a resolver that throws counts as unattended). `actorFor` stamps the context onto the
  caller's actor, proven or merely claimed, so the run's own commands are unattended whatever
  its pane identity or `--request` says. An unstamped actor built elsewhere is still found through
  the registry.

`assertUnattendedPolicy(actor, action, target?)` is a no-op for anything a person is behind. For an
unattended actor it enforces, in the change path rather than the skill:

| Action                                                    | Rule                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `yes` (`continue --yes/--choose`)                         | switch `safeYes` on; never a Keep going target; then the prompt budget                                |
| `prompt` (nudge), `ask`                                   | switch `nudges` on; never a Keep going target; then the prompt budget                                 |
| `archive`                                                 | `tier2Archive` or `emptySessionArchive` on; then that rule per target                                 |
| `close` (`delete` by the rules loop)                      | rules loop only, `emptySessionArchive` on with action `close`; then the blank-session rule per target |
| `handoff`, `consolidate`                                  | refused (D5: on the person's yes only)                                                                |
| `stop`, `restart`, `rename`, `answer`, `assign`, `resume` | refused: needs the person                                                                             |
| `hold` (`continue --when-idle`)                           | refused: the steward sends when free or not at all                                                    |
| `organize` (bulk organize/tag/hide/snooze)                | refused                                                                                               |
| `folder-change` (move, unarchive, delete, folder edits)   | refused (a cleanup session's `session delete` too)                                                    |

Where it runs: `continueSession`, `queueQuestion`, `assignSession`, `answerSession`,
`stopSession`/`restartSession`/`renameSession`, `transferSessions`, `sessionManage.resume`,
`sessionManage.continueWhenIdle`, assign by `--ref` (before any unarchive or resume),
`sessionFolders.mutate`
(also refuses a launch-filing claim), `sessionOrganization.organize --apply`, and
`relayOrganizationChange` (by executor: `app/steward`, or a registered pane).
`omni session tidy` from an unattended caller follows the Tier 2 rule instead of the on-request
rule: it needs no `--request`, refuses `--include`, holds (with the reason) every archive row on
another computer or that Tier 2 does not pass, re-checks Tier 2 at the moment of archiving, and
records the Tier 2 evidence and no `request`.

A delivery by an unattended actor also never stops Keep going: `SessionDeliveryDeps.keepGoingOn`
is read instead, and a session found driven (or unreadable) is refused before anything is bound
or queued.

## Hooks the rules loop provides (WP-S2, registered by `startSessionSteward`)

```ts
setStewardPolicyHooks({
  tier2Eligibility?: (input: { target: OrganizationTarget; context }) =>
    Promise<{ ok: true; evidence: string } | { ok: false; reason: string }>,
  promptBudget?: (request: { context; kind: 'yes' | 'prompt' | 'ask'; entry; source; text }) =>
    Promise<{ ok: true; settle?: (queued: boolean) => void } | { ok: false; reason: string }>
}): () => void
```

- Until they are registered every unattended archive and prompt is refused
  (`STEWARD_TIER2_UNAVAILABLE`, `STEWARD_PROMPT_LIMITS_UNAVAILABLE`).
- `tier2Eligibility` must do its own locality check first (`remoteExecutionRefusal`); it is asked
  once when a tidy plan is made and again just before each archive. A throw counts as "no".
- `promptBudget` is asked after every other check, just before Keep going would be read and the
  prompt bound, with the exact text (marker included); it owns the per-session caps (3 Yes a
  day, 2 turns without new evidence, 1 nudge per 12 h). There is no per-Mac daily cap (Sal,
  26 Sep). `settle(true)` follows a queued prompt, `settle(false)` one that sent nothing. Dry runs
  never ask it.
- The rules loop acts in-process with `{ kind: 'steward', feature: 'rules' }` through the same
  functions (`continueSession`, `queueQuestion`, `relayOrganizationChange` with executor
  `app/steward`, `audit: { actor: auditActor(steward) }`, `reason: 'finished, not verified'`).

## The rules loop (WP-S2)

Code: `src/main/session-steward/` (`steward-runtime.ts` starts it from `src/main/index.ts`).
A pass runs every 60 s and 2.5 s after any finished turn, only with `enabled` on and without
`OMNI_STEWARD_DISABLED`. It reads the sidebar once, then observes only sessions whose cheap
signature (turn, last hook report, queue, Keep going, row flags) changed or whose next check is
due (at most every 30 min), with 8 observations and 3 judgements at a time.

Left alone first (`stewardSkipReason`): another computer, a host it cannot see, a pending launch,
unknown state, pinned, Keep going, a live runner or chain, a held `--when-idle` prompt, the
person's own question, a provider limit. Then at most one move, each behind its switch:

| Session                        | Move                                                                                                                                                                                     | Limits                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| waiting for a yes              | Yes on a single step (several options are the person's choice), clear of every hard stop and not a question, that JEV (when on) scores ≥ 3 of 4 for "advances the original request"      | 3 per session per day; never twice on a turn; stops after 2 turns in a row with no new commit or change |
| idle, JEV: work left           | a fixed-text nudge, after 15 quiet minutes                                                                                                                                               | 1 per 12 h, 2 in all, then Stalled; a refused nudge is Stalled with the refusal                         |
| idle, JEV: unclear, 2 h quiet  | "In two lines: is your task complete, and what is left?"                                                                                                                                 | once per 24 h; its answer is the next turn JEV reads                                                    |
| idle, nobody ever prompted it  | close (the sidebar's Delete; its agent stops), after `emptySessionCloseMinutes` (2) quiet and off screen; at once when its agent exited; or archive with `emptySessionAction: 'archive'` | the blank-session rules below                                                                           |
| idle or exited, JEV: finished  | Tier 2 archive, "finished, not verified"                                                                                                                                                 | the Tier 2 rules below                                                                                  |
| working, 10 min without output | reported (Work card), never restarted                                                                                                                                                    | —                                                                                                       |

Every prompt goes through `continueSession`/`queueQuestion` as `{ kind: 'steward', feature:
'rules' }`, so the hard stops, delivery fences and marker apply; the audit line reads
`actor: steward`. Limits live in `<userData>/session-steward/state.json` and are spent (with an
intent) before anything is queued; a prompt that sent nothing gives them back; an intent a crash
left behind stays spent and is never resent. There is no Mac-wide cap (Sal, 26 Sep); the Work
card reports how many prompts were sent today. Stalled clears on the session's next turn.

JEV off (`JEV_DECISIONS_DISABLED`, the doneness switch, or no JEV host) stops nudges, the question
and Tier 2. Safe Yes carries on with its mechanical checks only (one own step, clear of every hard
stop, the per-session limits) and says so in its activity line; while JEV is on, its ≥ 3 score is
required and a missing reading waits. The silent report, Stalled list, waiter check and wakes
carry on either way.

**Tier 2** (`steward-tier2.ts`, also S1's `tier2Eligibility` for automatic cleanup sessions), in
order: local and visible; idle or exited; no question, queue, own steps, plan wait or held
prompt; no open recorded commitment (`sessionTidyHoldReason`); no waiter; not pinned, Saved or
brought back from the archive (`autoArchiveKeep` on the relay row); 6 h quiet since the later of
its last agent activity and the person's last organization change (unknown is never quiet); JEV
resolved ≥ 0.8 with ≤ 0.2 left, both outside the unsure band. Then a result card is built with no
model (end of the last reply, PRs it named with GitHub's facts when read, changed files, outcome
receipts, links) and saved to `<userData>/session-steward/results/` before the archive is relayed
with executor `app/steward`, reason `finished, not verified` and its evidence. Undo is the change
path's own; Unarchive sets `autoArchiveKeep`.

**Blank sessions** (`steward-empty-session.ts`, `steward-row-empty.ts`; Sal, 26–27 Sep): an
agent someone started and no person ever asked anything. Checked before the JEV readings, which a
blank session never has. Tier 2's vetoes up to the quiet time apply (local and visible, no
question, queue, own steps, wait, held prompt, commitment or waiter, not pinned, Saved or brought
back; the rules loop also skips Keep going, a plan or runner, a pending launch). Then nobody
prompted it, and either its agent exited (no wait: the row is removed at once) or it sits at its
prompt, quiet `emptySessionCloseMinutes` (2) since the later of its last activity and the last time
its tab was on screen (`lastSeenAt` on the relay row). An agent whose screen shows no idle marker
yet (state `unknown`) counts as at its prompt only on the untouched proof below with its own
process holding the terminal (`agentForeground`).

"Nobody" needs positive evidence (`steward-prompted-runtime.ts`), read as:

- `untouched`: this computer saw the agent start fresh (`isBlankFreshStart`: a `SessionStart` with
  source `startup` from Claude, Codex or Gemini, or OpenCode's `SessionStart`, which its plugin
  sends only for a newly created root session) and nothing reach the pane since: no other hook
  event, no typed input (sent or not), no turn, no lost or spooled hook POST, no server gap. The
  latest hook prompt is empty, no automated send has an unresolved draft in its input box, and for
  Claude and Codex the transcript is missing (Claude writes it on the first prompt) or read whole
  with no prompt.
- `none`: a Claude or Codex transcript read whole with no prompt, but no keystroke evidence.
- `marked`: only marked prompts (another session's or the steward's).
- `person` or `unknown` otherwise (a damaged, oversized or remote transcript, any read failure).

Close needs `untouched`; the archive action also takes `none` and `marked`. Kimi, OMP, Pi, Grok,
Droid, Devin, Copilot, Cursor, Amp and Hermes send no start that tells new from resumed, so they
stay `unknown` and are never cleaned up.

The evidence (`fresh-pane-evidence.ts`, `fresh-pane-evidence-store.ts`) is written to
`<userData>/session-steward/fresh-panes.json` at once on every start and touch, so it survives an
app restart. A record carried over reads `untouched` only when no spooled hook event for the pane
was drained at this start since its start (`HookEventTap.drainedSince`; a drained one marks it
touched), its agent's hooks spool while the app is down (Claude, Codex, Gemini; not OpenCode), its
hook row is still that start, and the process table shows the same agent pid, born no later than
the start, holding the terminal. Claude and Codex panes whose empty `SessionStart` row predates the
file are seeded once from the hydrated hook rows (no keystroke before the upgrade can be seen for
them). A damaged file vouches for nothing.

Close goes through `omni session delete`'s relay (`relayOrganizationMutation`, op `deleteSession`,
executor `app/steward`, reason `blank session: nobody prompted it, so the steward closed its
tab`), admitted by the rule again just before it goes (S1's `close` action, rules loop only).
The window then checks, synchronously, that the row's empty revision still matches the evidence's
digest (`emptySessionEvidence`, 16 hex characters), that its tab is not on screen, and that the tab
holds no other pane (`session-steward-close-check.ts`); then its tab closes the way ✕ does
(Recently closed can reopen it) and the toast offers Undo. The kill is sent without waiting, so
the steward's activity line says the agent stopped only when its provider or SSH host reported
that very process's exit (same PTY and incarnation) within 10 s (`watchPaneProcessStop`,
`pty-stop-receipt.ts`). A failed kill, a lost connection, no report, a daemon restart's made-up
exit (`synthetic`), or a process with no known incarnation reads "not confirmed stopped and may
still be running". Neither the
recorded reason nor the toast claims a stop. The empty revision is null while
the tab is on screen, a launch draft is pending, or the pane is working, asking or held, and it
changes with every status update, keystroke and look. There is no put-back after a close: the
window's check is the last gate. The archive action is the #801 path: reason `empty session:
started with no prompt`, evidence `nobody prompted it · idle N min`, no result card, and the
process keeps running.

**Blank sessions on SSH hosts** (`steward-remote-blank-rule.ts`, `steward-remote-blank.ts`; Sal,
27 Sep). Only the blank rules ever reach a session an SSH host runs; nudges, questions, Yes and
Tier 2 still skip it. A session another OmniConsole runs is left to that computer's own steward.

- **Connected host: close.** The relay forwards each SessionStart's `sessionStartSource` (older
  relays omit it, so nothing reads as a fresh start). `ingestRemote` feeds SSH hook events to the
  evidence tap. Their records live in memory only, fenced by a per-connection epoch that
  `clearStatusEntriesForConnection` bumps on a lost transport; a reconnect's replay touches them.
  A pane reads `untouched` only while its host is connected and its pane live, with no transcript
  read (it is on the host), and only when the start carried the launch token this app run minted
  for the pane's PTY (`getAgentLaunchTokenForPane`), never an adopted or reattached terminal. The
  close is the same `deleteSession` relay: closing the tab ends the PTY through the relay.
- **Unreachable host: archive here only (the third rule).** Reason
  `STEWARD_UNREACHABLE_BLANK_REASON` (archived on this computer only; its remote process was not
  stopped), marker `blank on an unreachable host` and its own 16-hex token. The row must show:
  - host unavailable, tried and not reached (`auth-failed`, `reconnection-failed` or `error`;
    not `disconnected`, which a person may have chosen);
  - a launcher's title (`isJunkSessionTitle`), and no provider session or transcript;
  - a last hook report that is still the agent's empty start (`sessionBoundary`, no prompt or
    reply);
  - no prompt waiting in its queue (read directly: an unreachable host's observation shows
    none), no pending launch, nothing that pins, saves, holds or waits on it, and not on screen.

  The window keeps a clock per row in the sidebar view (`unreachableBlankClocks`, persisted like
  `doneArchiveClocks`, so a restart does not start the day over; a host still being decided keeps
  a clock but never starts one). Main counts the day from the later of that clock and the last
  time a relay connection to the host was ready (`ssh-reachability-log.ts`, kept across restarts),
  so a reconnect the window's clock missed starts it over. After 24 h the steward archives it
  through `relayOrganizationChange`; the evidence names the row (`unreachableBlankRowMarker`) and
  the host's last-reached stamp it was granted on (`unreachableBlankReachMarker`). The settle
  recheck accepts only this rule's grant for that same row with that same stamp, and the stamp is
  read again after the check's last await, so a reconnect at any point before settling puts the
  row back. The steward check routes it to this rule alone
  (`withUnreachableBlankRule`), the window's `automaticArchiveRefusal` checks its own branch
  (revision, token, clock), and the settle recheck re-reads the facts. When the host is back, the
  live rule closes it properly.

**Surfaces.** `sessionSteward.status` (moves in the last 24 h, Stalled, silent, prompts today)
and `sessionSteward.finished({ since })` (cards whose archive still stands) feed the Work card's
Steward activity section; "Finished since you last looked" remembers the last look in
`omni.steward-finished-seen.v1`. A Stalled session shows beside Needs you in the sidebar.
`omni session list` entries carry `stalled` and `waitedOnBy`; `--state stalled` filters on the
former. Tier 1 archive proof (Up next) is withheld while a waiter names the session.

**Seams for the other packages**, registered by `startSessionSteward`
(`steward-package-seams.ts`, and #751's held prompts in `steward-runtime.ts`):
`setSessionWaitersSource` ← WP-S3's `listSessionWaiters` (read by Tier 1, Tier 2 and `session
list`); `installSessionResultCardReader` ← the card store's `readingForPane`, so a Tier 2 card
meets a waiter's wait; `setStewardHeldDeliverySource` ← #751's held prompts, so a pane with a
prompt waiting or being sent is left to its sender. `setStewardCleanupStarter` ← WP-S4's
`admitCleanupRun('automatic', { leftovers })`, asked by the pile-up detector past
`pileupThreshold` leftovers or anything Stalled for a day, at most every 30 min, and only once the
window has listed its sessions (an earlier admission would spend one of the day's 3 runs on a
partial list); a refusal's `detail` (`capacity (codex)`, `3 automatic cleanup runs today`, …) is
what Steward activity records.

A finished session another one waits on is not archived, but its result card is still saved (once
per turn) so the waiter's wait can be met; once nothing waits on it, Tier 2 archives it as usual.
A waiter whose next step is blocked with a reason starting `Stalled: ` (it exited and could not be
resumed) joins the Stalled list, `session list --state stalled` and the pile-up count.

## Switches

`GlobalSettings.sessionSteward` (Settings › Session steward, one row per switch), every one on by
default (Sal, 25 Sep): `enabled`, `safeYes` (`on`/`shadow`/`off`), `nudges`, `tier2Archive`
(`on`/`shadow`/`off`), `automaticCleanup`, `sessionWaits`, `tier1WaiterCheck`,
`emptySessionArchive`, plus `pileupThreshold` (8), `emptySessionAction` (`close` or `archive`,
`close` by default) and `emptySessionCloseMinutes` (2, 1–1440; set under its switch; renamed from
`emptySessionMinutes`, whose stored 30 was only its first default and is not carried over). `shadow` is for diagnostics: it acts on nothing. `enabled: false` or
`OMNI_STEWARD_DISABLED=1` in main's environment turns every switch off. Main reads them with
`stewardFeatureOn(feature)` / `stewardFeatureMode(feature)`; `stewardSwitchRefusal(feature)`
gives the plain reason. `automaticCleanup` only takes effect once WP-S2 and WP-S4 are both in.

## For the other packages

- **WP-S2 (rules loop):** build `{ kind: 'steward', feature: 'rules' }`; register both hooks at
  start; read switches with `stewardFeatureOn`; archive through `relayOrganizationChange`.
- **WP-S3 (session waits):** gate the new wait on `stewardFeatureOn('sessionWaits')`, and the
  Tier 1 waiter check on `tier1WaiterCheck`. Resuming an exited waiter calls `resumeConversation`
  in-process with the steward actor; only the RPC (`sessionManage.resume`) refuses unattended
  callers, so gate that call on `sessionWaits` yourself.
- **WP-S4 (cleanup runs):** built and registered with the detector; see below.

## Cleanup runs (WP-S4, D7-A)

Code: `src/main/session-steward/cleanup-runs.ts` (the reservation), `cleanup-runs-runtime.ts`
(wiring, `admitCleanupRun`), `cleanup-automation.ts` (the automation and the brief),
`cleanup-capacity.ts`, `cleanup-run-caller-binding.ts`, `src/main/runtime/rpc/unattended-caller-gate.ts`.

- **One way in.** `admitCleanupRun(source: 'automatic' | 'manual', { leftovers? })` is synchronous:
  it writes `<userData>/session-steward/cleanup.json` durably before it returns, then starts the
  run in the background. The detector (WP-S2) calls it with `automatic`; Work's **Clean up now**
  (`sessionSteward.cleanupNow`, window or local CLI only) with `manual`. Result:
  `{ ok: true, reservationId }` or `{ ok: false, reason: 'running' | 'daily-cap' | 'capacity' | 'disabled', detail }`.
- **One at a time.** The reservation frees only when its run reaches a final status. A run left
  `dispatching`/`dispatched` by a restart or a lost terminal keeps the slot until the automation
  service's own startup reconciliation settles it; a run left `pending` (never dispatched) is failed
  at startup; a reservation whose run was never created is released as `not-started`. An unreadable
  record is rebuilt from the run history, keeping any live run's slot.
- **Automatic only:** the `automaticCleanup` switch (and the env stop), no headless server, at most
  `CLEANUP_AUTOMATIC_DAILY_CAP` (3) reservations per local day (counted when taken, including runs
  that never started), and capacity: the account the run launches with (a pinned Codex account,
  else the default login) must be `ready` with a reading under 5 minutes old and at least 20% left
  in every window. Anything else is skipped as `capacity (<agent>)` with the reason; skips are folded
  and shown in Work. A click is the person asking: never capped, never capacity-gated.
- **The automation.** Created once (`creationKey: session-steward-cleanup`): "Session cleanup",
  disabled, a fresh session per run, `workspaceMode: 'existing'` on the folder workspace
  `<userData>/session-steward/workspace`, so no run creates a worktree. `AutomationRunTrigger` gains
  `automatic`, set only through `AutomationRunOptions.trigger` by main (no RPC schema carries it);
  clicks record `manual`. Each run's brief is the prompt override.
- **End.** When a run is `completed` (its report saved), main relays
  `{ kind: 'scheduleFinish', paneKey, tabId, action: 'end' }`; the window sets the same
  "When finished: End" a person can pick, and the finish tick closes the tab once its host confirms
  the session finished. Retried while no window answers.
- **Unattended, and bound.** An automatic run's pane is registered at `dispatched` and resolved from
  the run history (and the record, past retention) for that pane's whole life. Every Unix-socket
  RPC is checked before dispatch (`unattendedSocketCaller`): a caller whose claimed pane is a
  cleanup pane, or whose process ancestry (the CLI sends `callerPid`) reaches a live automatic run's
  PTY root, or reaches the PTY of an automatic run that finished in the last two hours and whose
  terminal is still open (the CLI sends no pane evidence for terminal methods), is unattended;
  while a run is live, a caller whose ancestry cannot be read is unattended too unless it proves a
  pane of another session. An unattended socket caller may call
  only `UNATTENDED_CALLER_METHODS` (reads, `session tidy`, and `ask`/`continue` under the steward's
  limits); `terminal.send`, `terminal.rename`, launches, automations, orchestration, folder and
  organize changes are refused with `unattended_refused`. `actorFor` stamps the bound context, so
  tidy runs the Tier 2 rule.

Known limits: a process that detaches from the run's PTY tree (double fork to init) and forges its
pane evidence is not bound by ancestry; a raw RPC client can claim a false `callerPid` (the `omni`
CLI never does). A person typing into a finished automatic cleanup pane before End closes it is
still treated as that run.

## Organizing (Phase 3): suggestions and the accuracy guard

Code: `src/main/session-steward/organize/` and `src/shared/session-steward-suggestions.ts`.

**Switches.** `sessionSteward.organize` (`session-steward-organize-settings.ts`): `refile` and
`retitle` (`on`/`off`/`paused`), `mergeSuggestions`, `projectSuggestions`,
`accuracyGuard: { windowDays: 14, minSamples: 5, maxCorrectionRate: 0.2 }`, `pairReadsPerDay`
(50). All on. `stewardOrganizeMode(feature)` reads `off` under `OMNI_STEWARD_DISABLED`,
`enabled: false` and `JEV_DECISIONS_DISABLED` (every organizing step is a JEV reading).

**Suggestions** (`stewardSuggestionsFor(userData)`, `<userData>/session-steward/suggestions.json`):
kinds `merge | project | unplaced`. `propose({ kind, targets, proposal, title, evidence })` keeps
one open suggestion per pair (targets in any order), returns null for a pair the person dismissed
in the last 30 days (`wasDismissed(pairKey)` lets a feature skip the JEV read), and a new
`unplaced` list replaces the open one. Open ones expire after 3 days. `open(kind?)` lists them.
RPCs (window only, strict params): `sessionSteward.suggestions`, `.acceptSuggestion({ id })`,
`.dismissSuggestion({ id })`, `.resumeOrganize({ feature })`.

**Accepting** (D5, "on the person's yes"). A package registers the action for its kind with
`registerStewardSuggestionAcceptor(kind, (suggestion, { actor, request }) => …)`. It runs with
`{ kind: 'steward', feature: 'suggestion', suggestionId }` and must pass `request` (`accepted in
Work`) to every change it makes. That actor is person-approved (`unattendedContextFor` → null) only
while `acceptStewardSuggestion` holds the acceptance; anywhere else, including a record replayed
from an audit line, it reads as the rules loop (fail closed). No RPC caller can claim it (the
refusal test covers `suggestion`). A failed action leaves the suggestion open. `unplaced` has no
action: the person files those from the sidebar.

**Accuracy guard** (`stewardAccuracyGuardFor(userData)`, `accuracy-guard.json`), per feature
(`refile` = `move` records, `retitle` = `title` records):

- `guard.record(feature, record)` after each applied steward change; changes carrying a `request`
  (accepted suggestions) are not samples.
- `guard.state(feature)` → `{ mode, samples, corrected, paused? }` before acting; act only on
  `mode === 'on'`. A sample is corrected when a later record's `undoOf` names it or a person
  changes the same field within 24 h. With ≥ `minSamples` in the window and more corrections than
  `ceil(samples × maxCorrectionRate)` (2 of 8 stays on, 3 pauses), it writes `paused` to Settings
  and the Work card shows "Re-filing paused: 3 of 8 moves undone." with Resume.
- Resume (Work, or the Settings switch turned back on) sets `on` and counts only changes after it.

**Only sessions a person has asked something.** Re-filing, merge suggestions and re-titling skip a
session whose first prompt is missing (an agent started with no prompt) or carries a session-manage
marker (`[from …]`, `[Question q-… from …]`: another session or the steward wrote it), via
`stewardPersonGoal`. Accepting a merge re-checks both sides, so an older suggestion between two
empty sessions is refused before anything is sent.

### Re-filing and projects (WP-O2)

Entry point: `runStewardOrganizePass(deps)` (`organize/steward-organize-pass.ts`); main builds the
real sources with `createStewardOrganize({ runtime, userDataPath })`; the rules loop
(`startSessionSteward({ …, organize })`) calls its `passIfDue()` after every rules pass, failed or
not, so organizing runs at most every 10 minutes and never while `enabled` is off.

- **Candidates** (`steward-refile-candidates.ts`): local, idle and free (`sessionOwnerLoad`), not
  pinned, saved, hidden or archived; placement owned by the steward or `launch`, or unfiled and
  never revoked; no person record for the key in the last 24 h; nothing pending.
- **Readings**: one JEV `choice` per candidate over up to 30 active folders (same repo first, never
  Saved, a batch folder or its own), re-read when the turn changed (after 1 h) or the reading is
  20 h old; at most 20 per pass. Stored in `organize-state.json`.
- **Move**: two readings 20 h–3 d apart name the same folder at ≥ 0.8, and no steward move of that
  session in 24 h. Applied through `organizeSessions` as `app/steward` with `expectedRevision`,
  reason `JEV folder fit 0.91, two readings`, and recorded with the accuracy guard. Off, paused or
  a JEV failure moves nothing that pass.
- **Couldn't place**: unfiled candidates below 0.8 (or `none`) → one `unplaced` suggestion.
- **New project folder**: among those, ≥ 3 in one repo that JEV reads as the same project
  (`SESSION_PROJECT_QUESTION`, both orders ≥ 0.8, every pair; `pairReadsPerDay` budget) get one
  folder `<repo> · <earliest goal's first clause>`. `stewardOwnsFolderName(folderHistory)` holds
  while no person has renamed it; `renameStewardFolder` refuses otherwise.
- **Projects**: a batch folder (window's `listBatchOrigins`) over a day old with ≥ 3 sessions and
  work in the last day → one `project` suggestion (pair key `project:folder:<id>`). Yes moves them
  into `Saved Sessions / <name>` as `app/steward` with `accepted in Work`: placement stays the
  steward's, so Tier 2 still applies.

### Titles and merges (WP-O3)

Both run in the same pass (`runStewardOrganizePass`). The organizing features act in-process
through the change path (`organizeSessions`, `recordTitleRename`), not through the session-manage
commands, so the unattended table above does not apply to them; their own gates (switch, guard,
ownership, idle, `expectedRevision`) do. A merge runs only on the person's Yes.

- **Re-titling** (`steward-retitle.ts`, `steward-title-reading.ts`, `steward-retitle-jev.ts`):
  each idle, local session whose activity changed is read once (transcript tail, at most 10 per
  pass). Triggers: a later pull-request goal (`sessionGoalGroups`, by position, so a PR GitHub
  cannot answer for is not a change); the executed task card attached or changed
  (`continuation.taskId`, `readConsoleTaskCard`; a card seen on the first reading is learned);
  or two finished turns in a row that JEV reads as off the goal (≤ 0.2, distinct turn keys, kept in
  `organize-state.json`). JEV then picks among the PR title, the card title, the latest
  instruction's first clause and "keep"; only a pick at ≥ 0.6 changes the title, as `app/steward`,
  origin `generated`, bound to the title's latest revision. Only a title owned by the app or a
  launch whose records are all `generated`, never revoked by a person; never within an hour of any
  title change (tried again later); recorded with the guard (`retitle`). JEV off or unsure changes
  nothing. The sidebar row shows "was: <old title>" for a day (`SessionRowWasTitle`, one throttled
  `sessionOrganization.recent` read).
- **Merge suggestions** (`steward-merge-suggest.ts`): idle, local, unpinned, unsaved pairs in one
  repo or top-level folder, never one tagged `independent` (a built-in tag:
  `omni session tag --add independent`) or whose batch origin is `independent`. Shared changed files
  (`findSessionConflicts`) are evidence alone; otherwise JEV's duplicate question in both orders
  ≥ 0.8 (pair budget). One suggestion per pair, 3-day expiry, dismissals kept 30 days. Yes hands
  the earlier-active session off to the later one as the accepting person.
- **Adoption** (`session-transfer-adoption.ts`): every handoff or merge, after the target's
  acknowledgement and before any archive, moves open waits on a source to the target
  (`steward-wait-repoint.ts`, registered at startup with `setSessionWaitRepointer`): the waiter's
  outcome set is recommitted through `SessionOutcomeService.commit`, bound to its revision, with
  only `event.ref` changed, so the old receipt resets and S3's wait admission runs again. A failure
  archives nothing.

Known limits: a cleanup session that strips its own pane evidence reads as the plain CLI, and
`omni terminal send`/`rename` are not session-manage actions; neither is new authority, but
neither carries the unattended context.

## Continuous Done archive policy (September 26)

Tier 2 now also requires the persisted Conversations clock-menu policy (default
two hours, or Off/custom), no unread completion bell, and a bounded archive review.
It does not infer external delivery from a completion claim. Both archive paths
share the final renderer clock/attention guard and durable reversible receipts.
See [session-auto-archive.md](./session-auto-archive.md) for the current rules.
