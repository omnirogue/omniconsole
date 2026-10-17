# Session prep ("Reverse Prompting")

Sal asks, in any chat conversation, for new sessions ("create sessions for X, Y and Z"). OmniConsole
takes that message instead of the conversation's agent, prepares the best execution prompt for
each outcome in the background, checks it, repairs it, and launches it as a normal conversation.
The person is asked something only when no research, inference or sensible default can answer it.

```
composer Enter ─▶ detect ─▶ sessionPrep.request ─▶ plan ─▶ per item (4 at a time):
   prepare (read-only agent in the workspace) ─▶ gate ─▶ repair ≤2 ─▶ launch
```

## Invariants

1. **The person is the only authority.** `sessionPrep.request` is a user-interface write
   (`assertSessionOutcomeUser`): the desktop renderer or a paired device. The connector exception
   below requires a signed operator assertion; local CLI identity, agents and workers grant no authority. Every launched prompt starts with the person's request verbatim and names the batch.
2. **The host is the only launcher.** Items launch through `createManagedWorktree` (new isolated
   workspace for code-changing items) or `createAgentSession` (same workspace otherwise). Nothing
   goes through `outcome commit`, so its quote rule (`session-outcome-revision.ts`) is unchanged.
3. **Nothing is silently dropped.** An item whose preparation fails twice, whose final check
   cannot run, or that still contradicts the request or adds unrequested risk after repair launches
   with the person's own words and a one-line note. A planner item that was dropped shows as
   "N skipped" in the status line with its reason on hover. An item cancelled before launch says so;
   one already launching cannot be stopped and still launches.
4. **Launch is once.** The item persists `launching` with its workspace name before the call and
   `launched` after; a restart that finds `launching` checks for that workspace before retrying.
5. **Read-only preparation.** Planner, preparer, reviser and judge run through the existing
   one-shot CLI specs (`claude -p --permission-mode plan`, `codex exec -s read-only`).

## App connector entry

`launch_ai_session` passes the person's exact words to the executor, which calls
`omni session prepare --connector-file`. The CLI is only a transport: without a BFF-signed
assertion, `sessionPrep.request` still refuses it. The BFF derives Sal/Eve/Uma identity from
the authenticated connector grant, never a tool argument, and refuses delegated native workers.
An operator's own OAuth connector clients have the same identity as their app connector;
this is not device/app attestation. Native workers and unsigned local CLI calls are refused,
but a process that obtains the operator's own OAuth credentials is inside that trust boundary.

The Ed25519 signature binds operator, exact text, `raw:false`, target execution host, workspace,
title, supplied launch choices, operation identity, nonce, launch/status purpose and a maximum
five-minute expiry.
The runtime verifies it using `OMNI_SESSION_PREP_VERIFY_KEY_FILE`, or
`~/.config/omni/session-prep-verify.pem` when that variable is unset. An explicit environment
path takes precedence; an invalid override never falls back to the default. The default
lets GUI launches work without login-shell variables or launchd environment setup.
Only the BFF has `OMNI_SESSION_PREP_SIGNING_KEY_FILE`. Missing/invalid files refuse. No real key is
created or installed by this change. Provisioning requires separate authorization.
The verifier must contain only a public PEM key. It uses the existing managed-file reader:
a regular, single-link, current-user-owned file with mode `0600`, beneath owned, non-writable-by-others,
non-symlink directories inside the runtime user's home. Public-readable `0644` keys are also refused
by that inherited policy. These checks do not isolate the runtime from another process using the
same OS account, which can replace that account's files or environment.
Runtime roots and host identity come from `~/.config/omni/ai-operations-host.json`.
The host-owned managed-tools descriptor must name the same operator and operation; its path
and results folder must match that operation's configured state directory. Remote workspaces
cannot be redirected through this entry.

A durable nonce ledger is written before accepting work. Replaying a start refuses, including
after restart. A damaged ledger refuses. The acceptance lock is in-process; request-ID deduplication
also prevents a second accepted launch of the same operation. The nonce file is not a cross-process
transaction or a defense against another same-user process replacing the ledger. Status reads use
`connector.statusOnly:true` with a signed `status` purpose: they can read only an already accepted,
identically bound operation and never schedule it. A status assertion cannot authorize a launch. Expired
assertions refuse even status reads; the connector can renew a signature for status. There is
no automatic raw-launch fallback after a prep failure or uncertain native launch.

One app operation produces one item containing the entire request, preserving its signed native
tools and receipt. Preparation, existing deterministic/JEV checks, at most two repairs and the
existing router remain in the path. Explicit raw/as-written requests bypass this entry in the
executor and retain the legacy launch path. `minimal` and `ultra` effort currently require raw
mode because the existing prep effort vocabulary does not support them.

The normal prepared prompt begins with the untrimmed original request. The results-folder line
is appended after preparation. The native launch keeps verified-account selection, managed tools,
operation identity and the complete launch receipt. Interrupted launches fail closed rather than
inferring a successful managed launch from a workspace alone.

## Task templates and reuse

Code rules classify the leading task action as code, research, ops, content or review and insert
that kind's guidance into the existing prompt writer/reviser. The fixed sections remain Outcome,
Done when, References, Constraints and How to work, plus decisions/assumptions when needed.
The default writer is Codex `gpt-6-luna` (prepare medium, revise low), measured on ten synthetic
requests with the unchanged JEV gate. The planner and fallback judge remain unchanged. Explicit
Claude writer overrides retain Sonnet. Classification adds no model call and changes no capacity
or execution routing policy. The measured candidate passes 9/10 initially and after repairs; the
remaining request falls back to its original words. Claude comparison and USD cost are unknown.

Owner lookup includes sleeping and archived local sessions. Every assignment requires an explicit
user choice, including sessions whose authority cannot be established. The existing assignment
path retains its audit record. Delivery waits one cancellable second and rechecks workspace
writers and serving listeners before resuming/sending. An unavailable scan refuses reuse.
A delivered prompt cannot be undone. Listener discovery does not prove absence of every external
serving relationship.

Connector-origin offers return `needs-review`; their synthetic source pane does not currently
mount the desktop composer buttons. The coordinator deferred the authenticated click path to a follow-up: a BFF-created OmniOS
Decisions page offering Continue/Start new, with a runtime-verified operator answer receipt.
Sal or Uma decide whether to build that follow-up; these PRs do not implement it. The signed entry grants no confirm/cancel/assign capability to app agents or local
CLI callers.

## Detection (deterministic, shared by the chat composer and terminals)

`detectSessionPrepRequest(text)` fires only on an explicit ask: a creation verb (create, start,
spin up, launch, open, kick off, fire up, prep/prepare, set up, make) followed within a few words by
`session(s)` (one typo tolerated: "sesssion", "sesion"), `new agent(s)` or `new conversation(s)`,
then what for (`for`, `to`, `that`, `which`, `with`, `on`, `about`, `:`, `,`, a list), or the token
`(sessions)`. A lead-in made only of filler ("ok", "yeah", "ok let's try it,") is skipped; a clause
with its own instruction is not ("fix this and create sessions for …" goes to the agent). A
question about sessions ("why did the pricing session fail?", "ok, should we create a session for
this?") does not fire. `/next`, `/queue` and slash commands win.

## Terminal sessions (Claude)

A request typed into a terminal Claude session is diverted by the managed `UserPromptSubmit` hook:
the agent-hook server answers with Claude's `{"decision":"block","reason":…}`, so the prompt never
reaches that agent, and session prep starts with the recent transcript as the conversation excerpt.
When the terminal is one of a project's threads (filed in it, its project chat, or a worker one of
those started), main asks the window for that project and sends its folder as `defaultFolder`, as
the composer does; with no window the request goes ahead without it.
The reason line tells the person what happened; `undo sessions` stops the latest batch from that
terminal and `agent:` in front of a message sends it to the agent as usual.

Only the person's own submit counts. The renderer's xterm input path (never a programmatic write)
reports each Enter with the line it rebuilt from the keystrokes; a prompt is the person's when it
matches a line typed in that PTY within 30 minutes (used once) or their Enter there came within
5 s. Startup prompts, queued input, `omni terminal send` and prepared sessions' own first prompts
never qualify. While the pane's agent is working nothing is diverted: a block would end its turn,
so a message typed mid-turn stays with that agent.

## Plan (one fast call)

Input: request, conversation excerpt (≤24k chars, attached by the composer), source agent, the
registered repositories. Output: ≤20 `PlannedItem`s, each with an `anchor` quoting the person's
words. The host checks every anchor against the request and the person's own lines of the excerpt
(whitespace/case/punctuation-insensitive, matched from a word start or anywhere in Chinese,
Japanese or Thai text, and containing at least one word besides filler like "create new sessions
for the"); an item without a matching anchor is
dropped with a note, so the plan can never add work the person did not ask for. The excerpt
indents every continuation line, so text an assistant quoted ("User: …") never counts as the
person's words. `direct` items launch the person's words. Items the person put in order
("A, then B") fold into one session that does them in sequence.

## Prepare (per item, parallel)

A read-only one-shot agent in the target workspace (the source workspace unless the person named
another registered repository — a hint matches a repository's name or folder name, else the one
repository whose name contains it) researches the code, plans and conversation and returns
`PreparedFields` as JSON. It sees the registered repositories and may name the one the work belongs
in (`repo`), citing that repository's files by absolute path; the item then moves there and those
references become relative. References may also be absolute files inside the person's home folder
(a PDF on the Desktop); they are checked for existence and never block the move. The host renders the prompt:

```
Your request (verbatim): …           ← safety net: the agent can always see what was asked
## Outcome / ## Done when / ## Decided already / ## References / ## Constraints / ## Assumptions
## How to work                         ← autonomy clause + stop-before-risk clause
Prepared by OmniConsole from your message in <conversation> (batch <id>, item <n>).
```

## Gate (measured 2026-09-23; see `docs/reference/session-prep-gate-evaluation.md`)

Deterministic, free: required fields (`outcome`, ≥2 `doneWhen`), unresolved placeholders
(`[TBD]`, `[NAME]`, `TODO`, `???`), cited paths that do not exist in the workspace, and risky
actions (deploy to production, force-push, delete data, refunds/charges, customer sends) that the
person's request does not mention.

JEV (`jev-1.13.0`, one batched call, ~0.3 s): `consistent` and `ready` (P < 0.5 fails and is
repaired), plus `needs_user` when the preparer proposed a question. On 124 labelled cases this rule
failed 1 of 44 good prompts and caught 12/12 contradictions, 10/12 unrequested scope, 12/12
placeholders and 7/8 genuine user-only gaps; Claude Sonnet alone failed 6 of 44 good prompts at
~16× the latency. JEV is unavailable (no key, kill switch, error) → the same questions go to a
Sonnet one-shot judge.

Asking the person: the preparer proposes `blockingQuestion` only for facts nobody else can supply.
JEV `needs_user` ≥ 0.8 accepts it; < 0.5 rejects it (repair: choose a sensible, reversible default
and record it under Assumptions); in between, the Sonnet judge decides. An accepted question does
not hold the launch: the session starts on Claude and asks it first, so it shows in Needs you
through the existing AskUserQuestion path and continues with full context once answered.

## Repair

A failed gate sends the failures back to the preparer as a revision (no new research unless a
reference was missing), up to 2 rounds. Then the best version launches with the unresolved findings
listed under "Open issues", except a contradiction or unrequested risk: those launch the person's
own words (keeping an accepted question) instead. If the check itself cannot run, the item also
launches the person's own words (fail closed).

## Choices (folder, agent, model, effort)

What the person names wins, and only what they name: "on codex", "use opus", "high effort",
"xhigh", "max effort", "put them in OmniRogue / Prototypes". The planner extracts these per item
(a batch-wide phrase covers every item); the host keeps a choice only when it is found in the
person's own words. Launch passes model and effort through the runtime's launch preferences
(Claude `--model/--effort`, Codex `-m/-c model_reasoning_effort=`); an effort a model does not offer
steps down to the highest it does, with a note. A named folder is found with the `omni folder`
rules (created under the deepest existing parent when missing) and every launched session is filed
there; a filing failure never blocks the launch (the item says why it is unfiled). An ask typed in a
conversation filed in a project also carries `defaultFolder` (the project folder's id) on the
request. The batch persists that id and resolves the existing folder before each launch. Items
with no explicitly named folder inherit that project's context and are filed there through the
recorded organization path, without creating an automatic batch folder. A missing project folder
is reported on the launched item; it is never recreated or replaced by a same-named folder.
Project context is resolved for the execution host, while folder identity stays on the controller.

With no stated effort the agent's own default stands; the preparer may raise a hard task to high
or xhigh but never lowers the default.

## Holds, as implemented

| Sal's hold               | v1 behaviour                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Open questions           | session launches on Claude and asks first (Needs you)                                |
| Safety floor, Production | the prompt carries a stop-before clause; the session asks at that step               |
| File overlap             | each code-changing item gets its own new workspace; siblings are named in the prompt |
| Changed ask              | anchors + the JEV fidelity questions; unanchored items are dropped with a note       |
| Big batch (>8)           | the plan waits for one click in the composer status line                             |

## Surfaces

The composer status line of the source conversation (live: preparing N · launched M · Undo;
Launch all for a big batch). Launched sessions are ordinary Active rows. Nothing is sent to the
source conversation's agent.

## Files

`src/shared/session-prep-{types,intent,prompt}.ts`, `src/main/session-prep/*`,
`src/main/runtime/rpc/methods/session-prep.ts`, renderer `native-chat/use-session-prep-*.ts(x)`.
