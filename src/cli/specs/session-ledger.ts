import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_LEDGER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'ledger'],
    summary:
      "Show this computer's conversation ledger as its paired computers receive it, or what it last kept of another computer's",
    usage: 'omni session ledger [--host <local|runtime:id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'host'],
    examples: [
      'omni session ledger',
      'omni session ledger --json',
      'omni session ledger --host runtime:<name-or-id> --json'
    ],
    notes: [
      "Read-only, and answered by OmniConsole's main process: it needs no window, so it works while omni session sidebar-counts cannot (a window off screen, busy or closed). Without --host: this computer's own ledger exactly as paired computers receive it now — from its window, or main-authored from what it saved when no window publishes (then no workspace reads complete). With --host runtime:<id>: the copy of that paired computer's ledger this computer last reconciled and kept on disk; it proves nothing current, so its rows read stale.",
      'Each record is reported as a parity row, as sidebar-counts --json reports rows: bucket ownerListed (its owner lists it) or heldByOwner (its owner holds it without listing it), identity c:<digest> (provider conversation) or p:pane:<paneKey> (a pane with no provider session yet), rest, and archived (null when the owner did not say).',
      '--json: {hostId, source (owner|receiver-snapshot|none), generation, revision, ledgerSource (window|main), windowCurrent?, listedAt, asOf?, savedAt?, coverage: [{worktreeId, complete}], removals, removalsTruncated?, rows: [{hostId, worktreeId, kind, agent, archived, label, bucket, verification, identity, conversation, paneIdentity?, rest, stale?}], counts: {ownerListed, heldByOwner, archived}, receivers?: [{hostId, savedAt}], readAt}. source none: no ledger yet (nothing listed since start), never received from that computer, or an older OmniConsole.'
    ]
  }
]
