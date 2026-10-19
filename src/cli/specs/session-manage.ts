import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { SESSION_SHOW_COMMAND_SPECS } from './session-show'
import { SESSION_OWNER_COMMAND_SPECS } from './session-owner'
import { SESSION_TRANSFER_COMMAND_SPECS } from './session-transfer'
import { SESSION_CONTINUE_WHEN_IDLE_FLAGS, SESSION_CONTINUE_WHEN_IDLE_NOTE } from './session-reuse'
import { SESSION_HISTORY_COMMAND_SPECS } from './session-history'
import { SESSION_HOSTS_COMMAND_SPECS } from './session-hosts'
import { SESSION_RELOCATE_COMMAND_SPECS } from './session-relocate'

const TARGET_NOTE =
  'Name the session with --pane <paneKey> (from omni session list; chat-view sessions have one too), --terminal <handle> (from omni terminal list) or --ref <ref> (from omni session search or session list; archived rows included, one pane only). It must be another session: a session cannot continue, ask, answer, stop or restart itself.'

const ACTOR_NOTE =
  'The acting session is the one this command runs in, proven by its pane launch evidence (the same proof omni outcome commit uses), never by a flag. Outside a proven pane it is the plain local CLI ("omni CLI"). Only the omni CLI on this computer may use these commands; a paired device or another computer is refused.'

const PROVENANCE_NOTE =
  '--reason says why; --request quotes the person\'s own words that asked for it. Both go into the audit log, <userData>/session-actions.jsonl: one JSON line per applied action {ts, actor ({paneKey,title} or "cli"), action, target, before, after, summary, reason, request}. A dry run writes nothing.'

const DRY_RUN_NOTE =
  '--dry-run runs every check the real command runs (a refusal is still a refusal, exit non-zero) and prints exactly what would change; nothing changes.'

const STATES_NOTE =
  'States: working · queued (idle, with prompts waiting in its queue) · provider-limited (a usage limit holds it) · awaiting-user (a permission prompt or its own question needs the person) · waiting-for-yes (idle with its own open proposal) · idle · exited · unknown. Execution verdict: live · unverifiable (its host could not be reached; never read as exited) · exited (positive evidence from the execution owner). Anything that cannot be verified is unknown: treat unknown and unverifiable as keep.'

const HARD_STOP_NOTE =
  'The Keep going hard stops apply to the exact text that would be sent: deploy, shared-branch (push or merge to main/master/main-next/omni-brand/develop/prod-*/release*, force push), delete-data, history, send (email, message, Slack, comments), payment, credentials, ad-spend (turning on, re-enabling or scaling ads, ad sets or campaigns; changing budgets, bids or spend limits), ad-enterprise (pausing OmniRogue Enterprise or webinar ads: flagged for Sal, never paused), ad-campaign-pause (pausing a whole campaign or ad account: pause ad sets instead), ad-pause (pausing, turning off or archiving ads or ad sets: allowed by default, refused only when the person set that session or every session to ask first). A hit is refused with "Refused (hard stop: <category>)" and nothing is sent.'

const QUEUE_NOTE =
  "Delivery is only through the target's own prompt queue, which waits until the target is free; nothing is typed into its terminal. If the target's Keep going is on it is turned off first (the same as the person's own answer), so nothing is sent twice. Refused when the target is awaiting-user (a queued prompt cannot answer a permission prompt or question; the person answers it in that session), provider-limited, exited, unknown (its agent is not confirmed running, so it could be at a shell) or unverifiable. A terminal session also needs agentForeground true: the process table must show its agent's own process holding the terminal (by command line, or the process its hook reports name). The prompt is bound to that process (pid, process group and start time) and re-proven before every write; if the agent left or was replaced meanwhile, or OmniConsole restarted, the prompt fails unsent. Every write into its terminal, Enter included, is also checked at that moment by the process that owns the terminal: the bound process must still lead the group holding it. Where that check is not available (Windows, or a terminal host still running from before this update) nothing is sent. A session another computer or an SSH host executes is sent to that computer, which checks its own rules and carries it out once (omni session hosts shows which computers can); an older or unreachable one is refused before anything is sent, and nothing is done here instead."

const PROVENANCE_FLAGS = ['reason', 'request', 'dry-run']

export const SESSION_MANAGE_COMMAND_SPECS: CommandSpec[] = [
  ...SESSION_TRANSFER_COMMAND_SPECS,
  ...SESSION_SHOW_COMMAND_SPECS,
  ...SESSION_HISTORY_COMMAND_SPECS,
  ...SESSION_OWNER_COMMAND_SPECS,
  ...SESSION_HOSTS_COMMAND_SPECS,
  ...SESSION_RELOCATE_COMMAND_SPECS,
  {
    path: ['session', 'list'],
    summary:
      'List every conversation in the Conversations sidebar with its state and what it waits on',
    usage:
      'omni session list [--host <local|ssh:id|runtime:id>] [--query "<terms>"] [--state <state>[,<state>...]] [--folder <id|path>] [--project <id|path>] [--include-archived] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'host',
      'query',
      'state',
      'folder',
      'project',
      'include-archived'
    ],
    examples: [
      'omni session list',
      'omni session list --state waiting-for-yes,awaiting-user --json',
      'omni session list --state stalled',
      'omni session list --folder "Clients / Acme"',
      'omni session list --project "OmniRogue / Ads" --json',
      'omni session list --include-archived --json',
      'omni session list --host ssh:target-id --query "marketing budget" --json'
    ],
    notes: [
      '--host selects an exact execution host identity. --query matches every literal term, ignoring case, in title, agent, workspace/path, folder, waiting reason or pending steps. Filters apply only to this controller’s sidebar: they do not discover background terminals without a sidebar row, other controllers’ inventories or historical transcripts. A disconnected matching session remains unverifiable. JSON includes scope on updated controllers; old strict controllers reject new filters, with no silent downgrade.',
      'Text: one line per session — "<state> · <verdict> · <title> · <agent> · <folder or unfiled>", then "pane <paneKey>" and, when there is one, "waiting on: …" and numbered open steps. --json: {sessions: [{paneKey, tabId, terminal, title, agent, kind (terminal|chat), worktreeId, worktreePath, workspace, hostId, folder, saved, archived, pinned, verdict, state, stateBasis, agentForeground, lastActivityAt, waitingOn, pendingSteps, queueLength, keepGoing, ref?, providerSessionId?, transcriptPath?, archiveKind?}]}. ref (<agent>:<id>@<host>, for --ref), providerSessionId and transcriptPath name the provider conversation its agent reported (the join omni session search makes); archiveKind is manual or automatic for archived rows. Older controllers omit them.',
      'stateBasis says what the state was read from: hook (a fresh report from the agent process holding the terminal now: working, or waiting on the person; a report never makes it idle, since nothing in it proves which process sent it), screen (the rendered screen under the agent\'s own process: a prompt to answer, a turn in flight, or a finished turn), title (its terminal title alone), process (a process table read now shows no agent left under its shell, stopped jobs included, or its provider recorded the exit; a suspended job is unknown, and no process reading is unverifiable), chat-host, or none. The text line shows "(from its screen)" and the like for the inferred ones. agentForeground is true only when the process table proves this session\'s agent process holds its terminal (false for a shell, another program or another agent; null for chat sessions or when unreadable). An idle state needs positive evidence on its screen or title now; a quiet screen alone stays unknown.',
      STATES_NOTE,
      '--state stalled lists what the session steward tried and could not move, with why ("stalled: …"); it combines with the states above and clears on the session\'s next turn. JSON entries may carry stalled: {at, reason} and waitedOnBy: [paneKey of each session waiting on its result].',
      'awaiting-user rows may include ask: {kind: permission|question, text, options: [{n, label}], fingerprint}. The fingerprint is required by session answer --expect. ask is absent when the prompt cannot be parsed reliably. A hook-only question can be shown but cannot be answered until its current screen layout is verified. Text output shows the prompt, options and fingerprint.',
      "pendingSteps are the session's own open next steps (its offered options when it asked, else its proposed steps), numbered for omni session continue --choose <n>. Archived sessions are left out unless --include-archived. --folder matches sessions filed directly in that folder.",
      "--project lists a project's threads, as its project page does: sessions filed anywhere in the project folder, the workers they dispatched, and the project chat (its coordinator, kept even when archived). A folder inside a project names that project; a folder that is not a project is refused. Each JSON entry gains projectStatus (working, needsYou, reviewReady, waiting, stopped, cantSee, done, or null when idle) and projectCoordinator: true on the project chat; scope.project names the project. reviewReady is a finished thread with something for its owner: a run sealed for review, an unread finish, or an open pull or merge request on a workspace no other session shares. Older controllers reject --project.",
      "Session parity: each entry carries the bucket fields omni session sidebar-counts --json reports — bucket (ownerListed, heldByOwner, receiverOnly, workflow), verification (verified, unverified, stale), identity (c:<digest>, p:pane:<paneKey> or w:<workflow tab>), conversation, paneIdentity?, rest?, stale?, bucketReason? — and the text line names its bucket. The JSON also carries parity: the unfiltered canonical population (every sidebar row whatever --host, --query, --state, --folder, --project or --include-archived select), identical to sidebar-counts' parity, with per-host bucket counts and each paired owner's ledger state. Older controllers omit them.",
      ACTOR_NOTE
    ]
  },
  {
    path: ['session', 'answer'],
    summary:
      "Answer another session's current permission prompt or question with a required fingerprint",
    usage:
      'omni session answer (--pane <key> | --terminal <handle>) (--allow | --deny | --choose <n> | --text "<reply>") --expect <fingerprint> [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'pane',
      'terminal',
      'allow',
      'deny',
      'choose',
      'text',
      'expect',
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session list --state awaiting-user --json',
      'omni session answer --pane tab-1:leaf-2 --allow --expect <fingerprint> --dry-run',
      'omni session answer --terminal term_abc123 --deny --expect <fingerprint> --reason "needs the person"',
      'omni session answer --pane tab-1:leaf-2 --choose 2 --expect <fingerprint> --request "use option two"',
      'omni session answer --pane tab-1:leaf-2 --text "Use the existing parser" --expect <fingerprint>'
    ],
    notes: [
      "Exactly one answer and --expect from the reviewed ask.fingerprint are required. The fingerprint covers the prompt text, its full command, whether it read completely, and each option's label, role and the exact value an answer sends. The target must be live and awaiting-user; unknown, unverifiable, exited, self, changed or unreadable prompts are refused. The prompt is read again before Keep going is turned off and again immediately before delivery.",
      '--allow and --deny are the only answers to a permission prompt. --allow selects only the one-time allow option. "don\'t ask again", always allow, allow-all and approvals scoped to a session, directory, project or workspace are never chosen, by --allow, --choose or --text. Any clipped option label refuses --allow. A permission whose agent-reported command disagrees with its screen is refused outright. --deny bypasses hard stops but still needs a verified prompt, matching fingerprint and an unambiguous deny/no option.',
      '--choose is for questions; the question, its full command or header and the option label are each checked against hard stops. "Other"/"Type something" rows are never chosen. --text is for supported structured free-text questions and Codex async questions, includes [from <actor>], and is checked too. File deletion, pushes/merges and history rewrites without provable scope are refused conservatively.',
      "Structured answers use agentSession.respondToApproval/respondToQuestion with revision checks and actor provenance; a structured question must carry its one single-choice question record matching the item (Codex chat questions carry none and are refused). PTY answers use exact single-step keys on recognized Claude Code/Codex screens, recheck before writing, and write only on positive evidence that the pane, its PTY and the agent's own waiting report still hold. PTY free text (except a Codex async question), grouped/multi-select/preview questions, unfamiliar layouts and screen-unavailable reads are refused.",
      "A Codex async question (request_user_input_async, no selector on screen; listed while its finished turn waits, including while only its children run) is answered with a message in Codex's reply layout: --choose <n> sends that option, --text sends your words. It goes through the same host function as the pane card and Needs you: every check runs before Keep going changes (the question is still pending, its report came from the Codex process that holds the terminal), then paste, settle and Enter are one input-queue turn, re-proven before each write, guarded at the terminal and fenced. An answer on its way from anywhere claims the question until Codex reports the turn it started, so a second answer is refused. The fingerprint includes the turn, so the same question asked again is a new one. It is confirmed by Codex's own report within 20 seconds, never by the screen. SSH sessions are refused: answer them in the terminal.",
      'This build answers Claude/Codex prompts only. PTY permissions require the recognized Bash/command approval menu. Multiple simultaneous structured prompts, missing one-time allow/deny options and answers exceeding the existing structured RPC limit (512 characters after option-id encoding) are refused.',
      'Keep going is turned off only after the last re-read. --json includes ask with all reviewed command/header evidence, commandText, chosen (including the exact value) and delivery (dry-run|recorded|confirmed|unconfirmed). For keys, confirmed needs two positive readings of a different state, at least 300 ms apart within 2 seconds, with no menu on screen; unconfirmed says why and exits non-zero. A keystroke that may have been sent but failed is reported as partly applied. A durable pending marker is written before dispatch and survives restarts. For terminal keys, unknown or unconfirmed answers block later answers on that pane until repeated positive readings prove departure; changed text alone never releases it. Structured responses, and Codex async questions, retain an unknown marker for the exact item (session and item; pane, turn and question), including across revision/fence changes. A distinct explicitly addressed structured item can be answered while earlier markers stay intact. Journal-derived working/idle never clears structured uncertainty. A proven no-write refusal clears only its own marker. Inspect the session and answer it there. Structured recorded means journaled; the provider can still report a delivery failure in its conversation. Answers cannot be undone.',
      HARD_STOP_NOTE,
      TARGET_NOTE,
      ACTOR_NOTE,
      DRY_RUN_NOTE,
      PROVENANCE_NOTE
    ]
  },
  {
    path: ['session', 'continue'],
    summary:
      'Continue another session: say yes to its own proposal, pick one of its steps, or queue a prompt',
    usage:
      'omni session continue (--pane <paneKey> | --terminal <handle> | --ref <ref>) (--yes | --choose <n> | --prompt "<text>" [--when-idle [--within <30m>] [--wait]]) [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'pane',
      'terminal',
      'ref',
      'yes',
      'choose',
      'prompt',
      ...SESSION_CONTINUE_WHEN_IDLE_FLAGS,
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session continue --pane tab-1:leaf-2 --yes --request "tell the ads session to go ahead"',
      'omni session continue --pane tab-1:leaf-2 --choose 2 --dry-run',
      'omni session continue --terminal term_abc123 --prompt "Run the unit tests and report the failures" --reason "Sal asked for a test pass"',
      'omni session continue --pane tab-1:leaf-2 --prompt "Also cover the export path" --when-idle --within 45m --reason "same files as its parser change"'
    ],
    notes: [
      '--yes sends the session\'s own single open proposal and --choose <n> one of its numbered pendingSteps: the same text and path as the one-click Yes in its tray, marked "[from <acting session>] ". --prompt queues your text with the same marker. Exactly one of the three.',
      "--yes and --choose send the step's own words, never the word yes, pinned to exactly the words that passed the hard stops: if its proposal changes before it is queued, nothing is sent.",
      '--prompt goes only to an idle session whose whole latest reply this host has read and which has nothing open, or to one this host positively knows has never replied (just launched): it is refused if that reply proposes any next step (answer those with --yes/--choose), ends on a question, or mentions anything a hard stop covers anywhere, and when the reply cannot be read in full. It never carries an approval: text that reads as one ("yes", "go ahead", "2") is refused, and the prompt goes with a fixed line saying it approves nothing.',
      'Both are bound to the reply they were checked against, by content: the queue checks it again before delivery, and so does every write into the terminal (the text, then Enter). While it is written, any change this host hears of for that conversation revokes it, and the process that writes the terminal (the terminal daemon, too) refuses the next write. If a refusal comes between the text and Enter, the text stays in its input box unsent: nothing more is sent to that session (its queue, Keep going, continue and ask all refuse) until you type in it.',
      QUEUE_NOTE,
      SESSION_CONTINUE_WHEN_IDLE_NOTE,
      HARD_STOP_NOTE,
      TARGET_NOTE,
      ACTOR_NOTE,
      'The window shows a toast naming the change; for --prompt its Undo takes the prompt back out while it is still waiting.',
      DRY_RUN_NOTE,
      PROVENANCE_NOTE
    ]
  },
  {
    path: ['session', 'ask'],
    summary: 'Ask another session a question and wait for its answer; it changes nothing',
    usage:
      'omni session ask (--pane <paneKey> | --terminal <handle> | --ref <ref>) --question "<text>" [--timeout-ms <n>] [--require-keep-going-off] [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'pane',
      'terminal',
      'ref',
      'question',
      'timeout-ms',
      'require-keep-going-off',
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session ask --pane tab-1:leaf-2 --question "Where are you at, and what is left?"',
      'omni session ask --terminal term_abc123 --question "Which files have you changed?" --timeout-ms 120000 --json'
    ],
    notes: [
      '--require-keep-going-off refuses if Keep going is on or unreadable, without changing it. The owner rechecks before queueing and delivery; an older runtime refuses this option. This option currently requires the recipient computer’s local CLI.',
      'Approval-shaped questions (yes, go ahead, a bare option number) are refused. Every question explicitly says it is not an approval; asking for information on an open proposal does not approve it.',
      'The question is queued behind the marker "[Question q-<id> from <acting session> — answer only, change nothing] " and delivered only when the session is free: a working session is never interrupted. q-<id> is new for every question, and the answer is the reply of the finished turn whose prompt is exactly that question, id included (another turn, another question\'s among them, is passed over).',
      'Prints the reply (--json: {outcome: answered|timeout|failed, reply, question, failure, note, sent, summary, ...}). Default wait 300000 ms (5 min), at most 1800000. On timeout a question still waiting in the queue is withdrawn unsent (question: withdrawn); one already delivered cannot be taken back (question: delivered) and its answer lands in that conversation. If OmniConsole restarts while it waits, a still-queued question to a terminal session fails unsent (the agent it was meant for can no longer be confirmed); ask again. Exits non-zero unless answered.',
      QUEUE_NOTE,
      HARD_STOP_NOTE,
      TARGET_NOTE,
      ACTOR_NOTE,
      DRY_RUN_NOTE,
      PROVENANCE_NOTE
    ]
  },
  {
    path: ['session', 'stop'],
    summary: "Interrupt another session's agent and turn its Keep going off",
    usage:
      'omni session stop (--pane <paneKey> | --terminal <handle> | --ref <ref>) [--force] [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'terminal', 'ref', 'force', ...PROVENANCE_FLAGS],
    examples: [
      'omni session stop --pane tab-1:leaf-2 --dry-run',
      'omni session stop --terminal term_abc123 --reason "duplicate work"'
    ],
    notes: [
      'Interrupts only a working (or, with --force, awaiting-user) agent, the same interrupt as omni terminal send --interrupt; an idle agent is not interrupted, so a second stop never exits it. Keep going is turned off either way. Its queued prompts stay queued.',
      'Refused for an awaiting-user or waiting-for-yes session (an unanswered decision) unless --force, and always for an exited, unknown or unverifiable one, or one another paired runtime executes. SSH stop requires a current ticket from the owning relay: it rechecks the exact foreground agent and refuses if any terminal input changed since inspection. Older relays refuse. A lost acknowledgement is uncertain and must be inspected before retrying. This does not enable SSH continue, ask, answer or restart. A chat-view session is stopped from its own tab.',
      TARGET_NOTE,
      ACTOR_NOTE,
      DRY_RUN_NOTE,
      PROVENANCE_NOTE
    ]
  },
  {
    path: ['session', 'restart'],
    summary: 'Resume an exited session in the same provider conversation, or unstick a hung one',
    usage:
      'omni session restart (--pane <paneKey> | --terminal <handle> | --ref <ref>) [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'terminal', 'ref', ...PROVENANCE_FLAGS],
    examples: [
      'omni session restart --pane tab-1:leaf-2',
      'omni session restart --pane tab-1:leaf-2 --dry-run'
    ],
    notes: [
      'An exited session is resumed the way its "Resume conversation" button does: the same provider session, reopened in a new tab from its checkpoint; nothing is re-sent. It is resumed (outcome restarted) only once the new pane’s agent itself reports that conversation, within 30 s; otherwise the outcome is started_unconfirmed with the reason, and with no report at all its checkpoint is kept on the new tab. Without a checkpoint it is refused: omni session resume --ref reopens it from its transcript instead, and also reopens a conversation whose tab was closed.',
      'A live session that is working but has printed nothing for 10 minutes reads as hung: it is interrupted (Keep going off) and restart waits up to 15 s for it to return to its prompt in the same conversation. Anything else live is refused. Unknown and unverifiable sessions are never restarted, and a chat-view session resumes from its own tab.',
      TARGET_NOTE,
      ACTOR_NOTE,
      DRY_RUN_NOTE,
      PROVENANCE_NOTE
    ]
  },
  {
    path: ['session', 'rename'],
    summary: 'Rename a conversation in the sidebar and on its tab',
    usage:
      'omni session rename [--pane <paneKey> | --terminal <handle> | --ref <ref>] --title "<text>" [--origin yours|generated|unknown] [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'pane',
      'terminal',
      'ref',
      'title',
      'origin',
      ...PROVENANCE_FLAGS
    ],
    examples: [
      'omni session rename --title "Ads: Q4 headlines" --origin yours --reason "the person named it" --request "call it Ads: Q4 headlines"',
      'omni session rename --pane tab-1:leaf-2 --title "Parser fix" --origin generated --reason "the old title was a launcher id"',
      'omni session rename --pane tab-1:leaf-2 --title "Parser fix" --dry-run'
    ],
    notes: [
      "The same as the sidebar row's rename: the tab's own title, which the sidebar shows first. The window shows a toast with Undo. Without --pane/--terminal it renames the session the command runs in (ORCA_PANE_KEY).",
      '--origin says whose words the title is: yours when the person told you the title ("rename it to X"), generated when you wrote it, unknown (the default) when you cannot say. A title of the person\'s is never offered for renaming later. Always pass --reason. The rename is recorded in the session history: omni session history shows it with who, why and whether it can be undone.',
      ACTOR_NOTE,
      DRY_RUN_NOTE,
      PROVENANCE_NOTE
    ]
  },
  {
    path: ['session', 'conflicts'],
    summary: 'Find live sessions changing the same files, or sharing one worktree',
    usage: 'omni session conflicts [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni session conflicts', 'omni session conflicts --json'],
    notes: [
      "Read-only. For live sessions, grouped by repository: each file changed (git working tree) in two or more worktrees of the same repo, with each worktree's branch and sessions, and every worktree two or more live sessions share, with its changed files. Git runs on each worktree's own host (local, WSL or SSH).",
      '--json: {repos: [{repo, sharedFiles: [{path, worktrees: [{worktreeId, path, branch, sessions: [{paneKey, title}]}]}], sharedWorktrees: [{worktreeId, path, branch, sessions, files}]}], skipped: [{worktreeId, path, reason, sessions}], checkedWorktrees}. skipped names folder workspaces (no git, so no git conflicts) and hosts whose git could not be read (unverifiable, not clean).',
      'To act on a conflict: omni session ask both sessions, or omni session stop one.'
    ]
  },
  {
    path: ['session', 'tidy'],
    summary:
      'Clean up the sessions: plan which finished conversations to archive (or delete), and do it when the person asks',
    usage:
      'omni session tidy [--delete [--unverified]] [--apply --request "<the person\'s words>"] [--include <paneKey|tabId>[,...]] [--reason "<why>"] [--host <local|ssh:id|runtime:id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'apply',
      'delete',
      'unverified',
      'include',
      'reason',
      'request',
      'host'
    ],
    examples: [
      'omni session tidy',
      'omni session tidy --json',
      'omni session tidy --apply --request "clean up the sessions"',
      'omni session tidy --apply --include tab-3:leaf-1 --request "archive the finished ones, the parser one too"',
      'omni session tidy --delete',
      'omni session tidy --delete --unverified --apply --request "delete all sessions"'
    ],
    notes: [
      "--delete deletes instead of archiving, and the plan is the value read: every row says delete or keep, and why. Deleting keeps the history (the tab reopens from Recently closed), so archived rows qualify too. Kept: working (stop and delete one on its own with omni session delete --force), pinned, saved, a routine's, waiting on the person (awaiting-user, waiting-for-yes, queued, provider-limited), open steps or a queue, an unfinished recorded commitment, a state read from its title alone, a launch still pending, the session running the cleanup and any split in its tab. --include lifts pinned, saved, routine, waiting, open steps, a commitment and recent activity, by pane key or, for a row with no pane, its tab id.",
      'Only sessions this computer runs are deleted. One another OmniConsole or an SSH host runs is kept, --unverified or not: closing its tab here would stop it there. Run omni session tidy --delete on that computer (for example over SSH); its rows mirrored here go when it deletes them.',
      '--unverified (with --delete) also deletes sessions this computer runs but cannot verify: no terminal attached, its state unknown, or a tab with no pane (left from an earlier run). Their row goes here and no terminal is ended (what it lists may be a live session shown elsewhere). One active in the last hour is kept (it may still be restoring) unless --include names it. Without --unverified they are kept.',
      'A steward run (an automatic cleanup session) can never --delete; only the person asks for it.',
      "Without --apply it is a dry run: nothing changes. --apply needs --request quoting the person's own words; run it only when the person asked for a cleanup. It never stops, closes, deletes, moves or renames anything, and never runs unattended.",
      "Every sidebar conversation gets one row with action archive, hold or skip and a plain reason. archive: exited, or idle with no pending steps, no queue and nothing waiting on the person. skip: unknown or unverifiable (a host that cannot be reached is never read as done), run by another computer or an SSH host, working, queued, provider-limited, awaiting-user, waiting-for-yes, pinned, Saved, already archived, or still launching. hold: its recorded commitment is not finished — outcomes not done, a failed or unsettled attempt, quarantine, work waiting for the owner's review, an open request for the person's attention, a held continuation, or a completion claim for an older plan.",
      "--include archives held sessions the person's request names (by pane key); a skip is never archived, named or not.",
      "--apply archives exactly the plan's archive rows through the same path as omni session archive: each is re-checked just before, and skipped with a reason if it changed; each archive writes its audit line (reason and request included) and shows a toast with Undo. Each row reports outcome archived, skipped or failed.",
      '--apply exits non-zero when it archives nothing (or any archive failed), and prints what it archived, the rows that changed since the plan, and every other row counted by reason. A zero-archive run is not a finished cleanup: report its reasons to the person.',
      'What tidy cannot reach today: rows on another OmniConsole (paired runtime), rows on an SSH host (connected or not), and local rows with no readable terminal attached are all skipped as unverifiable or remote. Only the host that runs a session can archive it on proof; archive those from that host, or by hand in the sidebar.',
      'titleFlags lists sessions whose title names a launcher or an id instead of the work; informational only.',
      'Text: a summary ("Would archive 7 · holding 2 · skipping 4 · 3 junk titles"), then rows grouped by action; --apply prints the report instead of every row. --json: {dryRun, actor, rows: [{paneKey, tabId, title, folder, hostId, state, verdict, action, reason, group?, included?, outcome?, outcomeReason?, auditError?}], titleFlags: [{paneKey, tabId, title}], counts: {archive, hold, skip, junkTitles}, applied?: {archived, skipped, failed}, report? (--apply): {archived: [{paneKey, tabId, title}], changed: [{paneKey, tabId, title, reason}], failed: [{paneKey, tabId, title, reason}], notArchived: [{group, reason, count}]}}. group: already-archived · launch-pending · other-omniconsole · host-disconnected · ssh-host · unverifiable · unknown-state · pinned · saved · busy · open-items · held (other on an older host).',
      ACTOR_NOTE
    ]
  }
]
