# Conversational waits

"Wait for Uma and Iris to approve on Slack, then upgrade Iris's account, then close this
session." A person says it in chat; the agent files it as an outcome plan; the session row reads
**Waiting**; when every wait clears, the **same conversation** continues with the receipts, then the
session closes or saves if they asked. Plan: `~/Work/Ops/Plans/Conversational-Waits-2026-09-24/`
(Sal approved all six decisions on 24 Sep 2026). The omnios side is `CONTRACT.md` there.

## One engine

The IDE outcome engine owns waiting, continuing and finishing. omnios only answers "has this
happened yet?" (`GET /api/waits/facts`) and posts an ask when told to (`POST /api/waits/ask`). There
is no new scheduler: an `event` condition is read by the verifier's existing pass
(`session-outcome-verification.ts`) — 30 s throttle, latched receipts, restart catch-up. A time wait
is read every pass (the clock is free).

## The `event` condition

`src/shared/session-outcome-event.ts`. `{source, match, personId?, personName?, ref?, since?, at?,
deadline?, onDeadline?}`; the whole object is part of `sessionOutcomeConditionKey`.

| source | ref | read by |
| --- | --- | --- |
| `slack`, `email` | the handle `outcome ask` returned | omnios facts |
| `jira` | issue key | omnios facts |
| `signin` | app key (`omniconsole`, …) | omnios facts |
| `github` | pull request URL | the forge lookup the session card uses (`readSessionPullRequestFacts`) |
| `time` | — (`at`) | the clock |
| `session` | the awaited session's pane key | this host's own records (`steward-awaited-session.ts`) |

A met fact counts only when `evidence.by.person_id` is the condition's `personId`. Receipt:
`event:<source>:<link>@<at>:<person>`.

Each reading is written to the outcome's runtime `waits[]` (never definition): status, `checkedAt`,
reason, excerpt, who, link. The row and the Waiting list read it.

## Waiting on another session

"Wait for the billing session to finish, then tell me what it did." A session wait is
`{source: 'session', match: 'result', ref: <pane key>}`. The agent gets the pane key from
`omni outcome wait --on-session <pane|ref>`. That command checks the session and prints the event;
it files nothing. The prompt must ask to wait for a session (`kind: 'session'` in
`next-outcome-wait-request.ts`).

- **Admission** (`session-wait-admission.ts`, at commit): the pane must belong to another session
  this computer runs. The host refuses the conversation itself, a remote or unknown pane, and a
  wait that would close a circle (A waits on B while B waits on A, at any length). It also refuses
  while the `sessionWaits` steward switch is off.
- **Reading** (every pass, no 30 s throttle): the wait is met when the awaited session has a result.
  That means a Tier 1 seal (`sessionCommitmentProof`) or a Tier 2 result card that the steward's
  card store registered through `installSessionResultCardReader`. A plan that is still open on that
  session means it is not done, even if an older plan of it was sealed. The receipt is
  `event:session:<pane>@seal-<hash>` or `@card-<hash>`, so it names the exact result that was picked
  up. The verifier latches the receipt, so a later result never wakes the waiter again. If the
  session runs on another host, or has gone without leaving a result, the wait reads
  `event-wait-unavailable` ("can't verify"). It is never met.
- **Keeping the awaited session:** `listSessionWaiters(runtime)` (`steward-waiters.ts`) lists every
  pending session wait, keyed by the awaited pane. A wait leaves the list once its receipt is
  recorded. Tier 1 auto-archive and the steward's Tier 2 archive keep any session that is still
  listed.
- **Waking:** the same-conversation route runs, with its durable receipt written before a byte
  moves, so the waiter wakes exactly once.
- **An exited waiter** is resumed before the route would refuse with "reopen that session"
  (`steward-waiter-resume.ts`, through `resumeConversation`). The step is then delivered into the
  resumed pane. A waiter that cannot be resumed (a remote session, no reported conversation, no
  transcript) reads `Stalled: …` with the reason.
- **Capability:** `sessionChain.outcomeCapabilities` reports `sessionWaits: 1`. The CLI refuses
  `--on-session` and a commit carrying a session wait on a host without it.

## Status

`session-outcome-event-hold.ts`, reached from `sessionOutcomeVerificationHold`:

- pending → `waiting` / `event-wait`, wake `Uma ✓, Iris ○ on Slack`;
- `unavailable` (no grant, omnios down, 404) → `waiting` / `event-wait-unavailable`, wake
  `Follow-up not scheduled: <reason>` — never a silent wait; it is still polled;
- `needs_you` (an answer that is not a yes) or a passed `deadline` → `attention` /
  `event-wait-needs-you` with one owner `decision` request: keep waiting, continue anyway, cancel.

The owner answers in the Waiting list (`sessionChain.chooseOutcomeWait`, user only) or in chat
(`omni outcome wait --choice …` → `sessionChain.sourceWaitChoice`, admitted only when the owner's
own latest message states that choice). Keep waiting re-arms: only answers after that moment count,
and a passed deadline no longer asks. Continue anyway records an `owner-continued:` receipt. Cancel
sets the chain `cancelled`.

`review` conditions gained `require: 'approve'`: only an approval verifies; "needs changes" is the
owner's decision, never an early start of the work behind it. The host sets it on every
chat-filed person review that another outcome depends on.

`omni session list` reads the same waits (`conversationPlanWaits`): an idle conversation whose live
plan waits says `waitingOn: "Its plan is waiting for Sal approves on Slack (not yet, checked …)"`.
Its queue and its own proposals speak first; the state stays `idle`, so the wire vocabulary is unchanged.

## From chat

- The prompt hook (desktop listener and SSH relay) answers a wait, a person handoff, an explicit
  session finish or `@next` with one pointer (< 1 KB) at `omni outcome context`
  (`src/shared/next-step-chat-hook-reply.ts`); every other prompt still gets 204.
- `outcome context` returns `waits` parsed from the attested prompt
  (`next-outcome-wait-request.ts`), people resolved against the signed-in roster.
- Admission (`next-outcome-wait-evidence.ts`): an agent may file only a wait the prompt asked for —
  a roster person the prompt named, on the channel it named, for the answer it asked for; `since`
  within the last day; a Jira key or PR URL exactly as typed; deadlines only with an "if no answer by
  …" clause. The host stamps `personName` from the roster.
- `omni outcome ask --person --via slack|email --text` posts the ask through omnios, only when the
  prompt names that channel and that person (staff only; idempotent per conversation, message,
  person and channel).
- Work after a wait is its own outcome with an action `route: 'same-session'`: the executor delivers
  `sessionOutcomeWaitBrief` (receipts + the person's quoted next step) into the source conversation
  through the existing same-conversation route — queued until the conversation is free, never typed
  over a working turn. `sessionFinish` runs after every outcome.

## omnios, live (24 Sep 2026)

`/api/waits/*` is live on omnios (console #544, build 5a732477), reached with the desktop bearer.
What the IDE sees:

- A 200 with `status: unavailable` is shown verbatim as "Follow-up not scheduled: <reason>" (for
  example "no grant for clerk_*.read" while the Clerk keys are not on the hub).
- A 4xx with omnios's own `error.code` (`person_not_on_roster`, `ask_refused`, …) reaches the agent as
  "omnios refused the ask: <message>". Only a 404 without a code means the route is missing.
- Slack asks go out from the OmniOS bot ("Slack App") to the vetted Slack IDs in
  `OMNI_WAIT_SLACK_USERS`; a replayed `operation_id` returns the same handle.

## Capability

`sessionChain.outcomeCapabilities` reports `eventWaits: 1` and `event` in `supportedEvidence`. The
CLI refuses to send an `event` condition, `require`, or an action `route` to a host without it.

## Not yet

- An exited source conversation blocks the continued step ("reopen that session"). The exception is
  a plan that waits on another session: its exited waiter is resumed first (see above).
- Waits resume after a reboot only when the app opens (Phase 2: a login item / headless host).
- omnios does not show a session's waits yet (CONTRACT.md §3).
