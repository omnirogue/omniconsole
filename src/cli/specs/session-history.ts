import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const READ_ONLY_NOTE =
  'Read-only: it changes nothing. Read it before moving, renaming, archiving or hiding a session, so you do not undo what the person or another session just did. The window does not need to be open for omni session actions; omni session history --pane needs it to find the row.'

export const SESSION_HISTORY_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'history'],
    summary: 'Show how one session was moved, renamed, archived, tagged or hidden, and by whom',
    usage: 'omni session history [--pane <paneKey> | --terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'pane', 'terminal'],
    examples: [
      'omni session history',
      'omni session history --pane tab-1:leaf-2',
      'omni session history --pane tab-1:leaf-2 --json'
    ],
    notes: [
      'Newest first, one line per change: "time · what · who · reason · evidence · undoable". who is you (the person, and where: sidebar, work, notice, pane-rename), a session by its title (proven by its pane), the omni CLI, a launch, another device (sync) or the app. A change to many sessions at once is one line. Without --pane/--terminal it reads the session the command runs in (ORCA_PANE_KEY).',
      'A placement or title the person set is theirs for good: the history ends with "… is yours for good" and no agent or sync takes it back. A title line names whose words it is (your words, generated, origin unknown).',
      'undoable means Undo in the session details would still put it back. Undo never overwrites a session changed since.',
      '--json: {key, row, entries: [{opId, kind, targets, value, executor, origin, reason, request, evidence, phase, ts, before, after, revision, error}], pending, ownership, revocations, undoable: [opId]}.',
      READ_ONLY_NOTE
    ]
  },
  {
    path: ['session', 'actions'],
    summary: 'List recent session actions: every move, rename, archive, stop, ask and the rest',
    usage:
      'omni session actions [--since <30m|24h|7d>] [--actor person|pane|cli|launch|sync|app] [--kind <kind>[,<kind>...]] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'since', 'actor', 'kind', 'limit'],
    examples: [
      'omni session actions',
      'omni session actions --since 2h --actor pane',
      'omni session actions --since 7d --kind move,title --json'
    ],
    notes: [
      'Reads the audit trail, <userData>/session-actions.jsonl and its rotated .1, newest first; default the last 24 hours, at most 500 lines. An organization change is one line however many sessions it touched, showing its latest phase (applied, failed, or interrupted).',
      '--actor filters by who acted (person, pane = a proven session, cli, launch, sync, app). --kind matches an organization kind (move, archive, unarchive, delete, title, tag, untag, hide, unhide, snooze, folder.move, …) or an action (stop, restart, continue, ask, answer, rename, session.move, …).',
      '--json: {actions: [{ts, actor, action, target, summary, reason, request, opId, phase, executor, origin, organization}]}.',
      READ_ONLY_NOTE
    ]
  }
]
