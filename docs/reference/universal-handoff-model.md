# Universal handoff audit — 2026-09-11

Sal's ask (2026-09-11): before building the proposed next-step UI, simplify it to ONE
universal handoff model — three controls (＋ Add next · ⏳ Wait · ✓ Done), "who gets
this next?" instead of "what kind of orchestration?", humans and agents through the
same picker, parallel from multi-select, rounds inside the agent step, no approval
primitive. This audit measures branch `sal` at `9faf13f41a` (1.9.5) against that model
and names what is reused, what is folded, and what the engine has to grow.

## 1. What the user is asked today (measured)

| Surface | Entry control | What it asks first | Concepts exposed |
| --- | --- | --- | --- |
| Sessions sidebar row | `+` "Queue a session after X" | Dialog with two tabs: **Start another session** / **Send for review** | agent vs person is a mode switch; per step: Agent, Action preset, Model, Effort, Account, Objective (required); "Add another session"; auto-continue checkbox |
| Attention "Working on" header | send icon **Next step** | "When X finishes, send its final files to teammates through the task" | sentence box; **Send for** (review/approve/decide/edit/fyi); To (people, max 20); What to send (manifest/named files); Task; Note and due date; Save |
| Tasks → row detail | **Send…** | Dialog "Send task" | To (one person); **Requested action** (review/approve/decide/edit/fyi); Note (required); Files and due date; Send |
| Tasks → row detail | Workflow · Use task · Mark complete · Archive | — | four sibling verbs at the same rank as Send |
| Handoff thread (recipient) | Open task · Refresh · Start with my AI in a project · **Approve reviewed versions** · **Request changes** · Return updated file · Forward… | review note (required) | approve/request-changes verdict language; forward reopens the Send form with Requested action |
| Inbox → New handoff | To · Existing task ID (btk_) · Title · Handoff file · Or paste · One-line note · **Review AI instruction** | — | asks the person to type a card id and then pipes an instruction into their AI |
| Canvas / Local runs | templates (research→plan→produce→review→verify; fan-out→synthesize; improve×N) | graph editor | node/edge/graph vocabulary |

Four composers implement "who gets this next" (queue dialog, follow-up composer,
handoff send form, inbox compose). Two of them ask for an orchestration mode before a
recipient; two force a classification (Send for / Requested action) and a note.

## 2. What the engine already gives us (reuse)

- **Session chain** (`src/shared/session-chain-types.ts`, runner in
  `src/renderer/src/lib/session-chain-*.ts`): ordered steps after one live session;
  a step is an agent launch (agent, preset, model, effort, account, objective) or a
  people handoff (`SessionFollowUpRule`: recipients ≤20, deliverables, note, due).
  Persisted in the profile state file, resumes after a restart, launches only after
  the source goes idle or exits cleanly. Mixed agent→person chains are legal in the
  type and in the runner (`sourcePaneKeyForStep` skips handoff steps) but no creation
  path builds one: `createSessionChain` maps agent drafts only,
  `saveSessionFollowUp` writes a one-step chain.
- **Action presets** (`src/shared/session-action-presets.ts`): research, analyze, plan,
  implement, improve, synthesize, verify, review — one template each, workspace and
  global overrides, `{{objective}}`/`{{input}}`/`{{inputFiles}}`/`{{outputDir}}`. The
  UI still requires the person to type the objective; nothing pre-fills it.
- **People handoff** (hub `POST /api/team/tasks/{id}/handoffs` via the console BFF):
  one thread per recipient with an idempotent operation id, exact file versions by
  sha256, receipts, replies, forward, review, return. Threads carry `action` **nullable**
  (`omniagentos/collab/handoffs.py::thread_extras` accepts a missing action; threads
  before migration 327 keep NULL); the entry body (note) is required (1–8192 bytes).
  The IDE contract (`console-handoff-contract.ts::requested`) is what makes `action`
  mandatory — a client choice, not an architectural one.
- **Recipient side**: the hub's `POST /api/handoffs/{id}/entries` with `kind: done`
  resolves the thread; `kind: reply` marks it replied. The BFF relays it
  (`allowlist.py` line 34) and the MCP `act_on_handoff` already uses it. The IDE has no
  verb for it; it only knows review (approve/request_changes on file versions) and
  return.
- **Cards**: `PATCH /api/collab/board/{id}` (already used for `status: done` with
  `expected_revision`) accepts `defer_until`; the hub's ready set excludes deferred
  cards (`work.py` READY = not deferred past) and the Todo projection carries
  `defer_until`/`paused_at`. Nothing in the IDE writes it.
- **Parallel**: only the local-run graph (`local-run-templates.ts` fan-out→synthesize,
  `maxConcurrent`). The session chain is strictly sequential (`currentIndex`).
- **Rounds**: only the local-run `improve-steps` template (N sequential nodes).
- **Wait / snooze**: none for sessions or threads. The Sessions tree can hide groups
  per device (`store/session-sidebar-view.ts`), not rows, and not until a time.
- **Done**: cards — `backoffice:completeTask` (revision-fenced); threads — only through
  the review verdicts; sessions — nothing.

## 3. Verdicts against the simpler model

| Model rule | Verdict | What changes |
| --- | --- | --- |
| One question first: who gets this next? | **Fold** the four composers into one picker (`components/next-step/`): 🤖 Agents (detected on the workspace host) and 👤 People (active roster), searchable, multi-select. The queue dialog, the follow-up composer's controls, the Send form and the Inbox compose become callers of the same panel. | new panel; old dialogs removed or reduced to a shell around it |
| Agents and humans share the handoff concept | Chain steps already model both; **allow mixed chains** from one draft (`compileNextStepChain`). | `createSessionChain` accepts handoff steps |
| Multi-select = parallel | **Grow the chain** with a `group` on steps: members launch together after the same source; the step after the group waits on every launched pane and reads all outputs. No "Multiple agents" choice. | `sourcePaneKeysForStep`, runner waits on N panes, prompt merges N inputs |
| Convergence asked only when needed | "When it finishes / When everyone finishes" appears only once an agent is chosen: an ordered **Then…** list of follow-on steps (any action with its glyph, or a person), each fed by the one before; empty means nothing more. A person after a fan-out receives every branch's manifest. Templates (🔬 Research → 📝 Plan; 🔬 → 📝 → 🛠 Create; 👀👀👀 The Council → 🧩; 🤖🤖🤖 Compare answers → 🧩) fill the same draft — no second engine. | `after: NextStepAfterStep[]`, `next-step-templates.ts`, `manifests` deliverables |
| Rounds inside the agent step | `Rounds: N` on improve/review/verify expands to N sequential steps with a `round` mark for the summary (`↻ 3 rounds`). No repeat primitive. | compile-time expansion |
| Instructions pre-filled | Choosing the action fills the objective with a plain sentence ("Here is the current work. Improve it and return the updated result."); the preset template still frames it. Editable, never blank. | `defaultNextStepInstructions(presetId)` |
| Human handoff = name + note + Send | `action` becomes optional end to end (contract, rule, client omits it, hub stores NULL); the note gets a default line when empty (the hub needs a body). The "Ask for" select is gone (round 2): nothing asks a person to classify a handoff; a forward on a thread carries the thread's own ask because the relay requires one. | contract + rule + client |
| A person is involved only through a task | Nobody picks a task. A card or thread already names its task; a session uses the workspace's card, and when there is none **Send creates the card** (`POST /api/collab/board`, title = the note's first line or the session label) and binds the workspace to it, so ✓ later completes the same card. Agents-only steps create nothing. | `backoffice:createTask`, `ensureTaskForPeople` |
| No approval primitive | Nothing new. "Approve" survives only as the file-version review panel on a thread, collapsed under "Review file versions". | — |
| Recipients get the same controls | A received thread shows ＋ ⏳ ✓: ＋ people = reply to the author (`reply` entry) or forward to anyone else; ＋ agent = start it with my AI (existing launch); ✓ = `done` entry (resolves); ⏳ = local wait. | `respond` verb |
| ⏳ Wait | An attention control, the same for a session, a card and a thread: a fast dial (1h · 2h · 4h · 8h · 12h · 24h · 36h · 48h, or a date/time for longer) hides it from Active, Needs You and the Attention badge on this device and brings it back on its own; the Sessions tree keeps it under a collapsed **Waiting** group with "Waiting · 12h · Returns at 8:30 AM". While it waits, the same ⏳ opens on **Bring back now**. A device that cannot save the wait says so. Nothing underneath is stopped, paused or changed (the hub's day-granular `defer_until` is deliberately not used: it is a card fact everyone sees, not my attention). | `store/wait-later` |
| ✓ Done | "Nothing else needs to happen here." Cards: existing completion. Threads: `done` entry. Sessions, with or without a card: the bound card (when Tasks knows it) is completed, then the session is **closed** the way a person closes a tab — history kept, reopenable from Recently closed — and it leaves every attention surface. A session whose agent is still working — in any pane of the tab — is refused with a plain sentence (Done is normal completion, never a kill; Stop stays a separate act). The message says what actually happened: closed, kept open (a pinned tab's prompt declined), or a bound card Tasks has not read that was therefore not completed. | `closeTerminalTab` + per-device finished mark |
| Status icons communicate, never ask | The saved chain reads as a strip — `Current → ✨ Improve · Claude → 👤 Uma → Done` (a fan-out folds to `🤖🤖 3 × 👀 Review`, rounds to `↻ 3 × ✨ Improve`) — and opens to its steps and the people step's receipt. Action glyphs: ✨ Improve · 👀 Review · ✓ Verify · 🔎 Analyze · 🔬 Research · 📝 Plan · 🛠 Implement · 🧩 Synthesize; 🤖 agent · 👤 person · 📎 files · ⋯ more. | `next-step-glyphs.ts`, `describeSessionChainStrip` |

## 4. Kept as-is (contextual, underneath the three controls)

- Deliverables (manifest or the final summary), due date, account, workspace template
  overrides: all under "More options" of the relevant recipient card.
- Follow-up receipt (retry / cancel / confirm finished) for a saved people step; the
  Waiting For rows; the failed-chain row and its Dismiss.
- Handoff file-version review (approve / request changes / return updated file):
  contextual on a thread that carries files.
- Canvas / local runs: untouched; a separate surface for people who want the graph.
- Inbox → New handoff (AI-mediated `peer_handoff` instruction): left in place this
  round; it becomes a caller of the same panel once the Inbox lane is revisited.

## 4b. Files and artifacts — audited, kept apart, invisible to the sender

- **File** = a durable, versioned bytes-on-a-card: the hub's `board_files`/handoff file
  versions pinned by sha256 (`handoff-files.py`, IDE `console-handoff-contract.ts`). A handoff
  carries *references* to versions; nothing is copied to make a handoff.
- **Artifact** = a published, rendered, shareable representation (the console's Artifacts page:
  HTML/Markdown share links on omnios). It is not part of a handoff and never needs to be.
- What travels by default: on a session, the run's manifest (when OmniConsole launched it) or
  the final summary; on a card, the card's current file versions; on a thread, its current
  versions. The sender sees one line ("📎 The task and its files are included") and can name
  files under More options. No new abstraction, no duplicate bytes.

## 4c. Review round 2 — Kimi K3 and GPT-6 Astra, independently, against the eight questions

Both found the three controls right and the engine reuse sound; neither asked for a fourth
control. Taken (no new concept, each a fix or a removal): ＋ ⏳ ✓ on the **Needs you** header
(both); **Bring back now** inside ⏳ (both); the "Ask for" select removed (both); "Start with
my AI in a project" (thread) and "Use task" (card) folded into ＋ → agent (both); the summary
line says the cost ("starts 3 sessions") (both); Done checks every pane of the tab, reports
closed / kept open / card-not-completed truthfully (Astra); the fan-out fold no longer hides a
person in the same group (Astra); "When the agents finish" when people are among a fan-out
(Astra); rounds reset to 1 when a second recipient is added instead of being dropped silently,
and later steps offer rounds only for improve/review/verify (Astra); a cleared model or effort
stays cleared, and switching a later step's agent drops the previous agent's model/effort/account
(Astra); Change on an armed launch step edits the armed draft (Astra); Compare answers asks for
answers instead of three Implement runs (Astra); a fruitless agent search says "no match", not
"no agents" (Astra); effort dropped from the one-line summary — it stays on the card (Kimi); the
Then… editor and templates are available on the launch subject too (Astra).

Declined, with the reason: the strip's terminal "Done" and its leading "Current" are Sal's own
words for the display; 36h stays because the dial was specified as eight snap points; "Set next"
stays on the launch subject because nothing is sent until the session starts; a defaulted-off
🧩 Synthesize offer, a "why it came back" badge after a wait, and editing a saved chain in place
are noted follow-ups, not added controls; 📎 named-file selection is not re-added (what travels
is said, not asked).

## 5. Not done in this round (named)

- The native chat composer gets no ＋ yet; the Attention launch bar does (pre-arm a
  next step while typing the request; it binds to the session the launch creates).
- Editing a saved multi-step chain: the follow-up receipt's Edit stays available only
  for a one-step people chain; a mixed chain is cancelled and re-added.
- A time-based ("clock") trigger for agents: chains still fire on completion only.
- A "back from waiting" badge on the row once a wait expires (it simply returns).
- A chain saved from a newer build whose every step is unknown vanishes silently on load
  instead of showing a labelled dead row.
