# Changelog

## Unreleased — Project repos: search and add from the dialog

- New project / Project settings → Repos: a search box filters the list by name or remote once it has four or more repos, chosen repos sort first with a "N chosen" count, and an **Add repo…** button opens the existing add flow in place (local folder, clone URL, or a path on an SSH host) so a repo can be registered without leaving the dialog. A repo added with a remote is ticked for the project at once; one without a remote stays listed with the usual explanation.

## Unreleased — Launch palette

- Usable provider icons beside the Conversations **+** launch with the existing launcher defaults. Right-click or long-press opens the provider's existing submenu; dragging onto a session launches in its workspace, and dragging onto a folder heading files a launch there. The **+** keeps its keyboard path. See `docs/reference/launcher.md`.

## Unreleased — Proposed lane, cards for several companies, proposals from any chat

- Work → Kanban opens with a Proposed lane ahead of Backlog. A card is proposed when it carries the hub tag `proposed`; moving it to Backlog or Ready removes the tag (then runs the outcome verb), and any lane can be parked back to Proposed. A proposal that is already in progress shows in its real lane with a Proposed badge.
- A card can be for several companies: the hub files it under one company (`org_company_id`), the others are recorded as `company:<slug>` tags. Cards show every company as a chip, the domain, and the description; the company filter finds a card through any of its companies; the task sheet lists them. A company without a department is a normal filing.
- Create task gains "Also for" company chips and a "Proposed idea" switch; the session "+" menu gains "Propose an idea"; the board gains a Propose button. The tags are written on the card right after it is created; a refused tag write keeps the card and says so.
- "Add to a task" gains Company and Domain filters, a search that matches title, id, company and domain names and the next action, and rows that show `Company · Domain`.
- omni-console MCP logins now stick for Claude sessions OmniConsole launches. The Claude entry no longer carries the per-pane ledger ids in `headers` (which gave every pane its own saved-login key); local spawns write `"headersHelper": "<app>/Resources/mcp/omni-console-mcp-headers.sh"` instead, and the helper sends the same two ledger headers at connect time. Existing managed entries are rewritten on the next local spawn; pinned entries (`X-Omni-Client`), Codex, Gemini, Grok and SSH / paired-host / WSL spawns are unchanged. Each Claude profile needs one `claude mcp login omni-console` that then holds — with `CLAUDE_CONFIG_DIR` set to the profile directory for managed and legacy profiles, and unset for the default profile. Stale per-pane login slots are left in the Keychain and ignored. See `docs/reference/omni-console-mcp-login.md`.
- Artifacts page: with an OmniConsole server that reports page lifecycle, the list shows Name (with a kind chip and "rev N"), Who (agent and the publishing session, which opens on click), Status (Superseded → successor, Done, No action, Decided, Needs you, Pending) and Updated; type, size, expiry, audience and reviewers move to the row hover and the drawer. A Needs me · Open · Closed · All filter (default Open) and Group by session sit next to search. The row menu, right-click menu and drawer offer Mark done (approved on the current revision only), No action, Superseded by… (pick a loaded page or paste a link or id), Reopen, Remove successor and Open session. Checked rows get a bulk bar (Mark done · No action · Superseded by…) that confirms how many pages change and why others are skipped, sends each page fenced by its revision, names pages that changed since selection, and offers Undo with the exact inverse. The drawer adds a status line with audience, reviewers and decisions. An older server's list renders as before.
- Session work shows Superseded / Done / No action ahead of the review state for a shared page.
- Typed chat is sent as typed. No terminal hook (Claude, Codex, Gemini, Kimi; local, SSH or WSL) and no native chat path injects next-step, outcome-filing or board-proposal instructions into a message any more, so requests such as "make a handoff for Uma …" or "fix the bug where we close the session twice" are simply done. Next steps are set in ＋ Next actions and ideas through Propose an idea. Cards proposed from chat are still shown on the board even when the hub calls their source ineligible.

## 1.12.11 — task conversations on the ledger, in-place Kanban edits and chain failure visibility

- Attach a live IDE conversation to a task on the session ledger (#262).
- Edit Kanban tasks in place, with people and completion outcomes (#263).
- Native chat requests connect to Next steps with exact source authority (#268).
- Chat reviewer requests are editable in Next steps (#274).
- A chain step whose agent died now fails visibly, and the timeout every dispatch already recorded is enforced (#285).

## 1.12.10 — Claude on the Agent SDK, room collaboration and session progress

- Claude structured chat now runs on the Claude Agent SDK (macOS/Linux, behind the Structured Chat setting, ACP opt-in still wins), rendered through the same UI as Codex; live-verified against Claude Code 2.1.273 (upstream #18560 scoped, #18743) (#265).
- Rooms start from searchable sessions and tasks with a reviewed brief, reviewed session excerpts, append-only context updates, structured records, guided help and review actions, and discussion workflow drafts you can reopen from the room. Participant lists show every permitted colleague (#286, from Uma's omni-brand #228, #231, #237).
- Console auto-advance no longer races stopped or restarted workflows, deadlines or delayed responses; Claude and Codex sign-in requests carry no browser telemetry and the trusted desktop identity is restored (#286, from omni-brand #225, #237).
- Session details show what a session is doing, and list rows show its current step (#276).
- Stopping a worker reports the durable result, and paired browser automation keeps a usable retained viewport and returns focus to you (#226).
- Next steps task plans save a concrete model on the execution host when the model was left optional (#266).
- Advertising account totals keep unclassified campaign spend, and ad-set reads have time to finish (#261).

## 1.12.9 — session journal on SQLite, one input queue and task attachments

_Version 1.12.8 was published from the omni-brand line; this main-next release ships as 1.12.9._

- Session journal moved onto SQLite with hub task publications carried across epochs; pre-SQLite chats told how to continue (upstream #18652, #18808) (#255, #256).
- Chat sends, session-chain steps and worker prompts go through one per-session input queue (#246).
- Attach a live session or a handoff to a task from where you are, and see what a session is part of (#254).
- Kanban is one click away under Work, and Move to… uses the hub's lifecycle verb (#252).
- Worker stop settlement races and handoff acceptance are fixed (#242).
- Backoffice polling adapts its cadence and uses conditional reads, cutting peer-thread requests by about 80% (#248).
- Launches keep existing OmniConsole MCP server aliases (#250).

## 1.12.7 — ACP settings text and actual session effort

- The ACP option in Structured Chat settings and its launch messages show their real text instead of localization keys (#249).
- Sessions show the effort they actually run at next to the effort you requested, so a model that caps or ignores the setting is visible (#245).

## 1.12.6 — native chat catch-up and faster agent launches

- Native chat picks up the prerequisite part of upstream Orca's post-fork chat work: live tool progress, large structured results, and streaming-reply and attachment fixes. Claude Agent SDK structured chat and the later upstream items are not included (#240).
- Agent launches record each stage (process spawn, shell ready, startup command, agent hook) in the trace log, and the Codex shell-ready wait adapts instead of timing out on slow shells (#241).
- The rebased-upstream check skips its blob-dependent `git log` on partial clones, removing the slowest git call in the app for those repositories (#238).

## 1.12.5 — Tool Shelf matrix, browser logins, ACP chat and safer agent launches

- Settings → Backoffice → Tool Shelf shows people against access sections in one matrix, with templates, column toggles and CSV bulk changes (#234).
- Settings → Backoffice → Browser logins lists the shared AirTop browser profiles and re-runs a login when a site signs out (#232). Both panes show a plain empty or refused state until the matching Hub and Console updates are live.
- OMP installs pin to 18.2.0 and follow the launch permission preset. `--yolo` is added only when you pick Bypass, never by default (#235).
- Chat decodes Pi and Prime Agent transcripts through the OMP decoder. Support stays behind the existing native chat agent setting (#236).
- Native chat can talk to agents over the Agent Client Protocol. It is off unless you turn it on for a specific agent (#244).
- Includes the refreshed Console API snapshot and the localized attachment refusal from #227.

## 1.12.4 — personal Tasks and shared planning

- Tasks opens to Needs You, with Waiting For and Kanban alongside. Kanban defaults to the signed employee's own tasks, with an explicit all-visible filter.
- Create a task directly from Tasks or a conversation. Add notes, ordered planning steps, a due date, priority and files in the same form; saving a plan starts no sessions or handoffs.
- Edit task details with revision checks and saved-value verification. Retrying an attachment keeps the existing task and uploads only the remaining files.
- Attached conversations refresh changed task context before ordinary messages while preserving the original account, session, execution host and retry inputs. Older attachments offer Reattach for task updates when their previous context receipt is no longer available.
- Includes the latest task-prompt, context fallback and translation corrections from main-next.
- Opening an archived workspace on unavailable external storage no longer stalls file loading or unrelated file operations; the file panel shows a retryable error and the workspace record stays intact (#219).

## 1.12.3 — parent task Kanban and shared session context

- Work Kanban shows deliberately created parent tasks in Backlog, Ready, In Progress, Waiting, Review and Done. Each parent can hold many sessions; session requests remain in Needs You and Waiting For.
- Agents receive the shared task lifecycle rules and use guarded actions to maintain outcome status. Failed attempts stay visible as conditions, and completion retains the existing verification policy.
- Creating or attaching a task prepares its shared context and memory for the next chat or terminal-composer send. Changed accounts or reused sessions cannot inherit another conversation's pending context, and unavailable context is reported.
- Linked structured chats show Open task. Task details retain all distinct sessions, including sessions with the same title.
- Includes the latest Next actions hover/click fixes and safe background continuation after quitting the desktop.
- Next actions popovers (＋, Add agent, Team, Package, Saves to) open on hover and stay open on the click that follows; a press on the control that opened them no longer dismisses them (#215, #217).
- A teammate handoff's package starts with the files the session's workspace changed, with Look again, Add files… and Add from workspace… for extras; a run's manifest still takes precedence (#218).
- Chat-filed next steps carry each action as an exact excerpt of the user's words so the host binds the requested reviewer (#208); outcome continuation relaunches name every dropped switch (#216).
- Catalog keys, an apostrophe-safe card prompt and a defensive task-context read keep the branch green (#221).

## 1.12.2 — verified handoffs, paired downloads and task Drive requests

- Handoffs verify the published commit and received file bytes, preserve existing destination files, and retry incomplete publication safely.
- Paired browser downloads save to the computer and workspace where the transfer started, with checks for changed connections and destinations.
- Task Files shows the existing Google Drive folder and requests files after confirming the project and explaining persistent folder access. Uncertain requests remain visible without automatic resubmission.

## 1.12.1 — complete release with reviewer filing correction

- Includes the full 1.12.0 upgrade integration and the @mention cursor correction.
- Chat-filed reviewer actions quote the user's exact instruction so the host can bind the requested reviewer, including the late-arriving PR #208.
- Paired files use Download with their owning computer; runtime import limits cover the entire selection, and coordinator mutations retain the caller's own identity (#210).
- Compatibility fixtures now recognize the persisted WSL ownership markers and the shared dispatch prefix required by older peers.
- Supersedes the private 1.12.0 release draft before publication.

## 1.12.0 — shared team communication and complete upgrade integration

- Inbox supports direct messages to people, replies, unread badges, read controls and incoming notifications. Discussions and Handoff requests remain separate.
- Online Rooms in Discussions and Work connects to the same OmniRogue human and AI rooms, with account linking, roster mentions, ordered history and retry-safe sends.
- Handoff files preview their exact Markdown or text version; other formats retain verified downloads. Requests can remain independent of a task and continue in an AI workspace.
- Next actions opens from compact controls, supports Team selection, and recognizes next-step instructions in supported agent chats.
- Incorporates every missing beneficial upgrade from the historical PR audit, including native CLI aliases, mobile interoperability, recovery fixtures and signed Mac updater fixes.

## Unreleased — tag people and agents in chat

- Type `@` in chat and choose a person or enrolled agent, then send a message, link,
  file, or folder. Choose Decision, Request, Question, Plan, or Information to say
  what response you expect. Recipients and exact file versions are shown before send.
- Messages use the existing handoff threads and agent inbox. Replies and private
  downloads open inside chat, and returned agent replies appear in Needs You.
- Next Actions sends selected files, a message, final summary, or complete session
  history after verified completion, using the same recipients and delivery routes.
- Saved chat routing survives restart. Retries retain the original recipients,
  file versions, and request keys. Conflicting employee identities stop delivery.
- Work has a New message action for direct employee messages and human replies,
  carrying Uma's Inbox update into the current Needs You / Waiting For view.
- Person messages remain available after the AI exits. An unfinished tag or
  Prompt Engineer action cannot send a person-directed message to the AI.

## Unreleased — Shared collaboration (candidate)

- Inbox is restored with Discussions (messages and rooms) separate from Handoff
  requests. Work uses the same discussion views.
- Work includes existing project discussion rooms, members, delivery history and
  replies. Posting and replying use Next Step and the same canonical operations
  available to agents; joining is explicit.
- Pending messages recover their original content and operation after a reload,
  within the original signed-in account.
- Handoff file delivery preserves different work already at the recipient's
  destination and reports individual file failures.
- Handoff now reads available conversation output before trying to resolve a
  terminal, allowing a finished conversation with readable output to proceed.
- Existing shared Work history, exact-version file reviews, cardless handoffs
  and AI continuation chains are retained.

Candidate validation is still in progress; see
[collaboration verification](collaboration-unification-progress.md). These changes
have not been published or installed by this work.

## Unreleased — Durable Next actions

- Review and Handoff are direct controls, with multiple reviewers, review rounds,
  special instructions and sequential handoffs.
- Save several outcomes together, infer destinations from the request, and reopen
  the saved plan through an editable lock. Completion requires every outcome's
  verified evidence. Existing receipts survive ordinary edits and restarts.
- Manual Snooze/Wait controls are retired; automatic Waiting and Hide remain.
- Paired execution hosts own remote continuation, with explicit capability and
  reconnect checks. See [Next actions](readme/next-actions.md).

## 1.10.12 — click-first chat and reliable routines

- Current Claude/Codex recommendations and incoming handoffs expose primary actions using the existing send, handoff, review and completion capabilities.
- Chat shows readable work stages and keeps raw execution behind technical details.
- Routines report failed delivery, wait for actual completion, refresh run history, and can be created by dragging a conversation into Routines.
- Prompt Engineer refines a draft separately and submits its final prompt to a new normal session. Bulk selection includes Create Folder.
- Fresh chat launches use Bypass while preserving models, reasoning, system prompts, account defaults and orchestration. Paired launches retain host defaults.

## Unreleased — Conversations, Sessions and Tasks

A conversation does not need a task. Thousands of them can start and finish with
no task-management clutter. A task exists only when someone decides "I need to
make sure this gets done", and then it holds the work rather than becoming it.

- **Create task** is a fourth control beside ＋ ⏳ ✓ on a running conversation,
  deliberately not inside ＋: ＋ answers "who gets this next?" and needs a
  recipient; this answers "this must not get lost" and needs none. The same
  control offers "Add to a task" so a later conversation joins work already
  tracked, and once a conversation serves a task it opens that task.
- The form is a correction, not a questionnaire: the task's name comes from the
  conversation and its company, department and project come from the folder it
  runs in. People are "everyone involved"; who acts next is still ＋ Add Next.
- A conversation is registered with the hub only when it joins a task, and the
  link is the hub's own (`sessions.board_task_id`) — so a task holds sessions
  across machines and people, and nothing else is published.
- Cards the desktop creates are now filed under their company, department and
  project instead of landing in the estate's unfiled bucket.
- **Companies** shows durable work: company → department → project → tasks,
  filed by the card's own fields rather than by a folder on this disk. One line
  per task: its state, its name, who moves next. ❗ Needs you is an overlay, not
  a state — a task can be in progress and still need you. Work the tree cannot
  place is Unfiled; finished work is Finished; nothing is hidden.
- The task detail lists every conversation on this device working the task and
  every session the hub has recorded against it.

## Unreleased — Conversations

- The sidebar opens on Companies: the same company → department tree OmniOS shows
  (its marks, colours and order), with every conversation filed under the folder it
  runs in. A department starts closed unless something inside needs you or is
  working; a click pins it either way. What needs you floats to the top of each
  node and its count shows in red on the company; ▶ on a company or department
  starts a conversation there; the company name opens its page. Conversations
  outside every company folder sit under "Other conversations"; Waiting stays
  closed at the bottom. Conversations and Workspaces remain one toggle away.
- Dismiss: a 🔕 button on the Work list clears every machine-generated decision in
  your queue in one go — it counts first and asks you to confirm the number; decisions
  a person raised stay. Runs as you, through the console, so the hub accepts it.
- Every session says where it belongs: a "Company › Department" crumb, drawn with
  the company's own mark, sits on the Attention headers and the Start work bar for
  any workspace inside a company folder. The folder tree is read once and shared.
- Sessions are now Conversations, and they are the sidebar's first view (the
  workspace tree stays one toggle away). A conversation is named by what it is
  about — a manual name, else the generated one — never "Terminal 3"; a pencil on
  the row renames it.
- Every conversation shows its state as one glyph explained on hover: ❗ Needs you
  (red), ◌ Working, 🟠 Active, 🟢 Done, ⏳ Waiting. Within a group, what needs a
  person sorts first, then what is working, then the rest; Waiting sits collapsed
  at the bottom as "Waiting (N)".

## Unreleased — your companies, and releases from main-next

- Companies and the Work home show only the companies work is filed under — the
  same set the console's folder tree shows — instead of every record in the org
  tree. When the folder tree cannot be read, nothing is hidden.
- Releases now come from `main-next`: the release script and the release workflow
  accept a version commit on `main-next` (Uma's `omni-brand` keeps its dev channels).

## Unreleased — usage at a glance in the chat

- The chat composer gets a 🔋 battery beside Attach: its colour is the most-used window
  across every model you have set up (green · yellow · red, the status bar's own
  thresholds), the tooltip says which model and how much is left, and one click opens
  every model's windows with the same coloured bars, the next reset, a refresh, and
  the door to the full usage page. No second usage system: the snapshots, rules and
  colours are the status bar's.

## Unreleased — one universal handoff: ＋ Add next · ⏳ Wait · ✓ Done

- Three controls replace four composers. ＋ Add next asks only "Who gets this next?"
  with agents and people in one searchable list; ticking several is a fan-out and the
  convergence question ("When everyone finishes") appears only then. An agent then
  asks "What should it do?" (the existing actions) and pre-fills its instructions; a
  person gets the work, an optional note and Send. The queue dialog, the Next step
  dialog and the Send… form are gone; the Inbox handoff compose is unchanged this round.
- A people handoff no longer asks for a requested action; the hub keeps it NULL and
  the work says it. Nothing asks a person to classify a handoff any more; the due date
  stays under More options.
- A person is involved only through a task, and nobody picks one: a card or thread
  already names its task; a session uses the workspace's card, and when there is none,
  Send creates the card and binds the workspace to it, so ✓ Done later completes the
  same card. Agents-only steps create nothing.
- Review round: ＋ ⏳ ✓ sit on the Attention "Needs you" header too; ⏳ opens on
  "Bring back now" while something waits; "Start with my AI in a project" on a thread
  and "Use task" on a card are folded into ＋ → agent; the summary line says the cost
  ("starts 3 sessions"); Done checks every pane of the tab and reports closed, kept
  open, or a card it could not complete; a fan-out fold never hides a person; rounds
  reset to 1 when a second recipient is added; Compare answers asks for answers.
- ⏳ Wait is an attention control with a fast dial (1h … 48h, or a date/time): the
  session, card or thread leaves Active and Needs You on this device and comes back on
  its own; the Sessions tree keeps it under a collapsed Waiting group with its return
  time. Nothing underneath is stopped. ✓ Done means nothing else needs to happen:
  a card is completed, a thread gets the hub's own `done` entry, and a session — with or
  without a card — is closed like a tab (history kept) after completing its card; a
  session whose agent is still working is refused rather than killed.
- Then… follow-on steps and templates: after the recipients, an ordered list of
  actions or a person (each fed by the one before); 🔬 Research → 📝 Plan, 🔬 → 📝 → 🛠,
  👀👀👀 The Council → 🧩 and 🤖🤖🤖 Compare answers → 🧩 fill the same picker. Saved
  chains read as a strip: Current → ✨ Improve · Claude → 👤 Uma → Done.
- Session chains grow a fan-out group and a round mark: members launch together after
  the same source, the step after them waits on every pane and reads all outputs, and
  "Improve × 3" is three steps that feed each other. A person after a fan-out receives
  every branch's manifest.
- The controls live on the Attention "Working on" header, the Sessions row (＋), the
  Tasks detail and every received handoff thread; the Attention launch bar can arm a
  next step while the request is being typed.

## 1.9.2 — signed Mac release preparation

- Require Developer ID signing and Apple notarization for public Mac releases.
- Reject invalid installer identities and verify both architectures before publishing.
- Package the company updater feed and enable user-requested in-app updates only in signed builds.
- Preserve existing profiles and workspaces; macOS permission grants remain under user control.

## 1.9.1 — runs that survive a restart, finished workers that settle, console-only tasks

- Local runs are persisted under the profile's user data, so the Local runs list
  and canvas keep every run across a restart; a run the app died inside loads as
  failed and says so.
- A node whose worker wrote its report and deliverables but never sent
  `worker_done` is settled from the report on disk after two empty mailbox
  windows, instead of holding the run until someone relays it by hand.
- Task sources are console-only by default: Settings → Task Sources shows the
  OmniConsole backoffice and one switch that brings GitHub Issues, GitLab,
  Linear, Jira, Bitbucket, Azure DevOps and Gitea back exactly as configured.
- New profiles start on the production console (`https://app.omnisi.ai`);
  only a profile that explicitly chose Local keeps the loopback backoffice.
- The Jobs view renders the production console's projection again: listed jobs
  accept the hub's own task ids, and a workflow response that fails its contract
  names the mismatching fields.

## 1.9.0 — chained sessions, local runs, and the run canvas

- Queue several successors after a session with full actor control per step
  (agent, model, effort, account, preset). Each starts only after the previous
  session goes idle or exits, the chain survives an app restart mid-way while
  the terminal daemon lives, and it works in plain folders as well as
  repositories.
- Run a local build-and-review graph without a hub: research → plan → parallel
  implement → synthesize → verify as a mechanical DAG inside the IDE. Every node
  gets its own workspace (a subfolder, or a child workspace of a repository),
  its brief, report and manifest under `<workspace>/.omni/runs/`; gates,
  deliveries and worker questions surface on the run and are answered in place.
- Draw runs on a canvas under Jobs → Local runs: per-node state, actor,
  workspace, produced files, graph and timeline, plus a draft mode and templates
  for composing a run before it starts.
- Auto-advance admitted console graphs with local placement only, off by default.
- Launch account profiles reliably: the account directory rides inside managed
  launches for existing and newly created workspaces, OmniConsole's status hooks
  are mirrored into it, and Claude trusts the workspace in that account's
  config before the first prompt.
- Only the console launch path may mark a run Hub-dispatched; the Build + Review
  projection-task fix ships with a real-SQLite test.

## 1.8.0 — attention view and a foldable Sessions tree

- Add the Attention view: two screens and nothing else — the terminal being
  worked in on the left, and whichever terminal is waiting on a decision or
  input on the right, blank when nothing waits. Both are the live panes portaled
  out of the hidden workbench (no second PTY). Next/Previous walks the waiting
  panes oldest-first; a pane the user is typing in stays until they leave it;
  a waiting pane split inside the current tab shows that tab whole on the left.
  Picking a session in the sidebar swaps the left screen without leaving the view.
- Surface who needs the user everywhere: an Attention sidebar entry with a
  needs-you badge, tinted workspace cards with per-group counts on headers,
  and a pinned "Needs you" group plus highlighted rows in the Sessions tree.
- Fold the Sessions sidebar into a tree: user folders and per-workspace groups
  that collapse, drag-reorder, hide/unhide (with a "Show hidden" footer) and
  persist on this device; rows drag into folders and show their live agent
  state. The Workspaces tree gets a collapse/expand-all control.
- Include everything shipped in 1.7.3 on the omni-brand line (connector-delivered team knowledge) and the Hub start-receipt gate for canonical Orcha execution.

## 1.7.3 — connector-delivered team knowledge

- Register the omniOS MCP connector for Claude, Codex, Gemini, and Grok terminals launched by OmniConsole.
- Retire the managed global team-knowledge block only after validating the connector, with a dry run, backup, marker checks, and a kill switch.
- Keep each CLI process on its own connector session while child agents in the same process share their parent's session.

## 1.7.2 — session queue cleanup

- Localize the session folders, queued-successor controls, and Hub completion feedback.
- Register the existing Hub fetch and sidebar activation call sites with their safety censuses.

## 1.7.1 — local session chains

- Group real local and remote Orca sessions into personal folders without moving
  their repositories or worktrees.
- Queue one successor from a session row with `+`; choose its agent and
  instruction, then start it in the same workspace only after Orca verifies the
  source session is idle or exited successfully.
- Mark Hub tasks complete from the To Do list through the existing signed-person
  transport and revision fence; stale updates refresh instead of overwriting
  newer state.
- Keep Build+Review's existing mixed model-family reviewers and bounded review rounds unchanged.

## 1.7.0 — the IDE binds to the hub

- Keep Build+Review as an executor pattern bound to omnios cards: the start
  dialog takes the card, the Run and every builder/reviewer dispatch inherit it,
  each builder report and reviewer verdict is recorded on the card as a
  progress note with evidence, and "approved" means candidate for the hub's
  verification. The pipeline no longer owns completion; ad hoc runs without a
  card stay local and record nothing on omnios.
- Retain Orca's execution runtime, durable journals, leases, process fences,
  dispatch bookkeeping, stop confirmation, and federation transport. Bind
  admitted runs, worker dispatches, and dispatch contexts to their hub card;
  persist the card revision and next action as read-only business projections.
- Route business decisions and completion through omnios. Local decision gates
  control execution steps and cannot decide the outcome of a hub card.
- Carry the admitted card through To Do launches, child workers, and session
  revival with `OMNI_TASK_ID`, `OMNIOS_URL`, and the shared first-prompt protocol.
- Enable the public `omni-console` HTTP MCP endpoint by default for signed-in
  Claude Code and Codex launches. Preserve explicit disablement and custom
  configuration; the provider handles OAuth without an IDE-owned MCP token.
- Project committed run, checkpoint, confirmed-stop, and worker-exit observations
  to progress notes on the existing card, with local journal evidence. The local
  execution journal remains the durable observation source.
- Keep ad hoc work local until explicit admission. Discovering tabs, reading
  telemetry, and restoring sessions never create To Do items.
- Add the shared `SYSTEMS.md` contract and native-workbench `MISSION.md`.
