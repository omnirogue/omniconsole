import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const SESSION_FRAME_LOG_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'frame-log'],
    summary:
      'Switch the session frame log (a debug record of every session inventory frame) on or off, or show its status',
    usage: 'omni session frame-log [on [--for <8h>]|off|status] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'state', 'for'],
    positionalArgs: ['state'],
    examples: [
      'omni session frame-log on',
      'omni session frame-log on --for 24h',
      'omni session frame-log status --json',
      'omni session frame-log off'
    ],
    notes: [
      'Takes effect at once, without restarting OmniConsole. On lasts --for (default 8h, at most 48h; on again extends it), survives restarts until then, and switches itself off at expiry. Off (the default) records nothing.',
      'Writes one NDJSON file on this computer: logs/session-frames.ndjson in the OmniConsole data folder (on macOS ~/Library/Application Support/<profile>/logs/), rotated at 10 MB into .1 … .7, so at most 80 MB.',
      'Records: receiver frames (environment, workspace, publication epoch, version, removal, terminal tab ids, and the decision: applied, outranked, unmirrored, ignored or removal, with its reason), what an applied frame replaced or removed (terminal rows and agent conversations) and which computer those rows came from, owner-side transitions (incoming window snapshot, stored snapshot, preserved tabs, removals and the projection sent to each client, with any loss of tabs or agent evidence flagged and the writer named), ownership inputs per workspace, and rendered sidebar count changes. Owner writer stacks are positions in the minified bundle; resolve them with the hidden sourcemaps of that build.',
      'Observe-only: it never changes which frames are applied. This computer only; it does not switch the log on another computer.',
      '--json: {enabled, filePath, files, bytes, maxBytes, maxFiles, enabledAt, expiresAt, build: {appVersion, commit}}.'
    ]
  },
  {
    path: ['session', 'sidebar-counts'],
    summary:
      'Show the Sessions sidebar counts per computer and the Archived count exactly as this window last rendered them',
    usage: 'omni session sidebar-counts [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['omni session sidebar-counts', 'omni session sidebar-counts --json'],
    notes: [
      'Read-only. switchHostCounts are the rows of the host switch itself (every host it lists, zeros included); sessionCountsByHost lists only hosts that have sessions, as counted. The rows are the conversations (one per provider session) those counts were made from, each with the computer it was counted under and whether it is archived.',
      'available is false (with a reason, and no counts) when the Sessions sidebar is not on screen (another sidebar panel, or a headless OmniConsole) or this window has not finished restoring its sessions. renderedAt and readAt tell how fresh the counts are.',
      "Session parity: each row and each host's count is split by bucket — ownerListed (its owner's conversation ledger lists it; on the owner, its ledger's own rule publishes it), heldByOwner (a capture its owner holds without listing it; never a mismatch), receiverOnly (listed only on this computer) and workflow — so count = ownerListed + heldByOwner + receiverOnly + workflow (+ background, terminals the switch counts with no row); unverified (\"can't verify\"), stale (as of the last list) and archived count within it. Each row's identity is c:<digest>, p:pane:<paneKey> or w:<workflow tab>, as both computers name it. ownerLedgers gives each paired owner's ledger state: ready, stale (as of a restored list), older (an older OmniConsole there: paused and archived conversations not listed) or unreachable. parity is the unfiltered canonical population (every row before tag, agent and routine filters), identical to omni session list --json's; it is sent whenever this window has restored its sessions, even with the sidebar off screen. An older window sends none of these. With no window at all, read omni session ledger.",
      '--json: {available, reason?, onScreen, ready, renderedAt, readAt, switchHostCounts: [{hostId, label, count, ownerListed?, heldByOwner?, receiverOnly?, workflow?, unverified?, stale?, archived?, background?}], sessionCountsByHost: [same], archivedCount, hiddenCount, showArchived, hostFilter, rows: [{key, rowKey, hostId, worktreeId, kind, agent, paneKey, providerSession, archived, unavailable, launchPending, workflow, label, bucket?, verification?, identity?, conversation?, paneIdentity?, rest?, stale?, bucketReason?}], archiveKeys, hosts: [{hostId, label, kind, health, connectionStatus, reachable, graphStatus, appVersion, checkedAt}], ownerLedgers?: [{hostId, generation, revision, source, state, asOf}], parity?: {rows: [{hostId, worktreeId, kind, agent, archived, label, bucket, verification, identity, conversation, paneIdentity?, rest?, stale?, bucketReason?}], countsByHost: [{hostId, count, ownerListed, heldByOwner, receiverOnly, workflow, unverified, stale, archived}], ownerLedgers}, build: {appVersion, commit}}.'
    ]
  }
]
