import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SESSION_REUSE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'resume'],
    summary:
      'Bring a found conversation back on this computer: reopen one whose tab was closed, or resume an exited one',
    usage:
      'omni session resume --ref <ref> [--reason "<why>"] [--request "<the person\'s words>"] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'reason', 'request', 'dry-run'],
    examples: [
      'omni session search "side menu" --json',
      'omni session resume --ref claude:2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c@local --dry-run',
      'omni session resume --ref codex:6b7d1f0a-2c3e-4a5b-8c9d-0e1f2a3b4c5d@local --reason "Sal asked to continue the parser work"'
    ],
    notes: [
      '--ref is the ref omni session search (or session list) prints: <claude|codex>:<id>@<host>. Only conversations this computer ran can be resumed here; one on another computer or an SSH host is refused (resume it there).',
      'A sidebar row that still holds it answers first: open (live) means nothing to resume (outcome already-open, its pane printed); exited with a checkpoint resumes there, as omni session restart does (outcome restarted once its agent reports the same conversation, else started_unconfirmed with the reason). Otherwise its transcript is found under the profile it lives in (CLAUDE_CONFIG_DIR / CODEX_HOME, OmniConsole-managed accounts included) and it reopens in a new background tab in the folder it ran in, through the same agent-session resume the app uses. If another terminal already runs it, that one is used (outcome adopted), never a second copy.',
      'It succeeds (outcome resumed) only once the new pane’s agent itself reports this conversation, within 30 s. A different conversation in its place, or no report, is a failure that says so: the tab is left for the person to check and nothing is sent to it.',
      'Refused, changing nothing: two rows hold it (name one with omni session restart --pane), the person deleted or hid it in the sidebar, no transcript on this computer (source missing), more than one transcript (which account is ambiguous), no recorded folder, or a folder that is not a workspace OmniConsole has open. Refusals print the resume command to run by hand.',
      'Resuming never unarchives: an archived conversation stays under Archived (omni session archive --unarchive --ref <ref>). It never sends a prompt: omni session assign --ref <ref> --task … resumes it and gives it a task in one step (its first task is checked against the reply in its transcript).',
      '--json: {dryRun, action: resume, ref, outcome (already-open|restarted|started_unconfirmed|resumed|adopted), reason?, paneKey, tabId, terminal, cwd, profile: {variable, path, isDefault}, summary, actor, auditError?}.'
    ]
  },
  {
    path: ['session', 'pending'],
    summary: 'List prompts held for busy sessions (continue --when-idle), or cancel one',
    usage: 'omni session pending [--all] [--cancel <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'all', 'cancel'],
    examples: [
      'omni session pending',
      'omni session pending --all --json',
      'omni session pending --cancel held-0b6c2f7e-5a41-4f0e-9d4b-2c8e1f3a7d90'
    ],
    notes: [
      'Without --all: prompts still waiting (or being sent), and first, under NOT SENT, any that ended unsent (expired or unknown) until the session that held them lists them once. --all adds those that ended in the last 7 days: delivered, expired (its window ended before the session was free: not sent, nothing launched elsewhere), refused (the session exited, left the sidebar or runs on another host), cancelled, or unknown (OmniConsole stopped mid-send: check that session before sending again).',
      '--json: {deliveries: [{id, createdAt, expiresAt, actor, target: {paneKey, tabId, title}, text, reason?, request?, state, note, settledAt?, entryId?, seenAt?}]}.'
    ]
  }
]

/** Flags `session continue` takes for a held prompt; notes live on its own spec. */
export const SESSION_CONTINUE_WHEN_IDLE_FLAGS = ['when-idle', 'within', 'wait']

export const SESSION_CONTINUE_WHEN_IDLE_NOTE =
  '--when-idle holds a --prompt for a session that is busy and sends it the moment the session is free (idle, nothing queued, no open steps, nothing waiting on the person, Keep going off), through this same path: marker, hard stops and freeform rules are checked again then, exactly once. --within <30m|2h|90s> sets how long it may wait (default 30m, 1m–4h). If the session is not free in time the prompt is not sent and nothing is launched elsewhere: the ending is reported (audit line, the window’s toast, omni session pending). --wait holds the command until it is sent or the window ends (run it in the background to be told); without it the command returns the held id at once. A session that is already free gets the prompt now. Use it only when launching a new session would conflict (the busy session is changing the same files) or duplicate its work; otherwise launch new. Refused for a session that exited, another host’s session, and for itself.'
