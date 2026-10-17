import { GLOBAL_FLAGS, type CommandSpec } from '../args'
import { SESSION_CONTINUE_WHEN_IDLE_FLAGS } from './session-reuse'

export const SESSION_OWNER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'find-owner'],
    summary:
      'Before launching a new session, find a session on this computer already doing the task, editing its files, or doing related work',
    usage:
      'omni session find-owner --task "<the task text>" [--files <path>[,<path>...]] [--worktree <worktreeId>] [--folder <id|path>] [--repo <id|name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'task', 'files', 'worktree', 'folder', 'repo'],
    examples: [
      'omni session find-owner --task "Add retry to src/parser/*.ts and its tests" --json',
      'omni session find-owner --task "Fix the login redirect" --files src/auth/login.ts --json',
      'omni session find-owner --task "Draft the Q4 ad headlines" --folder "Clients / Acme" --json'
    ],
    notes: [
      'Read-only: it sends nothing. Where the task would run is --folder/--repo when given, otherwise the session running this command (its workspace, folder and repository). --worktree names the existing workspace it would run in (worktreeId from session list).',
      "Candidates are live sessions this computer executes, other than the caller (not archived, exited, unknown, unverifiable, SSH or paired-host). Strongest signal: file conflict — its worktree has uncommitted changes (the same git reading as omni session conflicts) to files the task names (paths, file names and globs in --task, plus --files), or it works in the --worktree target when that is a git worktree (a folder workspace holds unrelated sessions, so there it is only a shared place). Then a shared place (same workspace, folder or repository) or topic (a local transcript search hit). JEV judges up to 5 (conflict owners first, then free ones) against each session's goal and summary: related = a natural continuation at 0.8 or above; duplicate = the same deliverable at 0.8 or above in both orders. Unsure or unavailable JEV is never related or duplicate; a file conflict needs no JEV score.",
      'Free (light): idle, nothing queued, no open next steps, nothing waiting on the person, Keep going off, no outcome run or session chain driving it, and (terminals) its agent proven to hold its terminal.',
      'Past work: the same local transcript search (by what was said and by topic) also finds conversations no live session holds: archived (by hand or automatically), exited, or closed (no sidebar row; ones the person deleted or hid are left out). JEV judges up to 3 of them the same way against their first prompt and summary. Only a verified-complete one (filed by the automatic archive) counts as a finished result.',
      'Decision table, strongest first: duplicate (live) → do not launch; ask the owner (omni session ask), or assign when it is idle · a finished past conversation that delivered the same thing → reuse-output: point the person to its result (pastOwner.links), launch nothing · file-conflict owner idle → assign · file-conflict owner busy → conflict-owner-busy: do not launch a parallel editor; wait (assign --when-idle), or ask the owner · related and free → assign · related past conversation → unarchive-and-continue (archived) or resume (exited or closed): omni session assign --ref <pastOwner.ref>, which unarchives or resumes it and gives it the task · related and busy, no file overlap → busy-related: launch new (parallel work is efficient) · unrelated → launch-new · sessions unchecked or transcripts unsearched → coverage-incomplete: launch new and say so. A live session wins over a past one when both fit. launchNew says whether to launch; recommend is the next command. On busy-related, launch-new and coverage-incomplete it is the omni session launch command: with --worktree when --worktree was given; otherwise, when the repository is a project other computers share (github: or git: id), with --project <id> so the launch picks the computer and account with the most fresh verified capacity (omni host list --capacity shows them); that launch starts in a fresh worktree from the repo default base, so drop --project to stay on your branch, or replace it with --worktree for a checkout you made (the two are refused together). Fill in the provider and the brief file.',
      '--json: {disposition, launchNew, reason, recommend?, owner?, pastOwner?, taskFiles, candidates: [{paneKey, tabId, title, folder, worktreePath, state, light, load, signals (file-conflict|target-worktree|same-worktree|same-folder|same-repo|transcript-match), conflictFiles, related (0–1 or null), duplicate (0–1 or null), goal}], past: [{ref, kind (archived|exited|closed), title, paneKey, archiveKind, cwd, transcriptPath, lastActivityAt, related, duplicate, finished, links, goal}], unchecked: [{paneKey, title, reason}], jevError?}.'
    ]
  },
  {
    path: ['session', 'assign'],
    summary:
      'Give a related session a new task instead of launching a new one: a free one now, a busy one when it is free, a past one after unarchiving or resuming it',
    usage:
      'omni session assign (--pane <key> | --terminal <handle> | --ref <ref>) --task "<the task text>" --reason "<why this session>" [--when-idle [--within <30m>] [--wait]] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'pane',
      'terminal',
      'ref',
      'task',
      'reason',
      'request',
      'dry-run',
      ...SESSION_CONTINUE_WHEN_IDLE_FLAGS
    ],
    examples: [
      'omni session assign --ref claude:2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c@local --task "Add retry to the parser tests" --reason "find-owner: resume, continues its parser work"',
      'omni session assign --pane tab-2:leaf-1 --task "Also cover the export path" --when-idle --within 45m --reason "find-owner: conflict-owner-busy, same files"',
      'omni session assign --pane tab-2:leaf-1 --task "Add retry to the parser tests" --reason "find-owner: idle, same workspace, continues its parser work" --dry-run',
      'omni session assign --pane tab-2:leaf-1 --task "Add retry to the parser tests" --reason "find-owner: idle, same workspace" --request "add retries to the parser tests"'
    ],
    notes: [
      'Delivered exactly like omni session continue --prompt: through the target’s own queue with a "[from <you>] New task for you:" marker, the Keep going hard stops on the task text, and only to a target whose latest reply was read whole with no proposal or question. It re-checks that the target is still free and refuses (nothing sent) when it is not; launch a new session then.',
      'Audited in session-actions.jsonl as action assign with --reason and --request; the window shows a toast whose Undo takes the task back out of the queue while it still waits. --dry-run runs every check and changes nothing.',
      '--ref (find-owner’s pastOwner.ref, or a ref from session search) names a conversation that may have no open row. Archived: it is unarchived first (a recorded organization change with --reason; it stays visible). Exited or closed: it is resumed on this computer as omni session resume does (same conversation, its own folder and profile), then given the task once it reads as free (within 45 s), with its latest reply read from its transcript because this computer has not watched it reply yet: the same checks (no proposal, no question at its end, no hard stop), and the prompt is revoked if a newer turn appears. A live but busy row is refused (use --when-idle). Each step writes its own audit line; if a later step fails, what already happened is reported (partly applied). A conversation on another computer is refused.',
      '--when-idle (with --pane, --terminal, or --ref to an open row) holds the task for a busy session and gives it the moment the session is free, exactly once, as omni session continue --when-idle does; if it is not free in time it is reported back and nothing is launched elsewhere (omni session pending).'
    ]
  }
]
