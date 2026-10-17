// Owner-side session frame log, emission half (session-count fix, step 0): what the owner sent each
// client (subscription notifications and listAll answers, with the per-client navigation revision
// folded into the projected version), what listAll's read-path repair rewrote, and which workspaces
// listAll left out as owned by a paired runtime.

import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  diffSessionTabsMembership,
  summarizeSessionTabsFrame
} from '../../shared/session-frame-log'
import { recordSessionFrameLog } from '../observability/session-frame-log'
import {
  brief,
  DEDUPE_LIMIT,
  recordOwnerOwnershipInputs,
  resetOwnershipDedupeForTests
} from './session-frame-log-owner'

type Snapshot = RuntimeMobileSessionTabsSnapshot
type Frame = Snapshot | RuntimeMobileSessionTabsResult

/** Read-path reconciliation (listAll hydrates before answering): which workspaces it rewrote. */
export function recordOwnerRepairTransitions(
  path: string,
  before: ReadonlyMap<string, Snapshot>,
  after: ReadonlyMap<string, Snapshot>
): void {
  const changedWorktrees: string[] = []
  const lossWorktrees: string[] = []
  for (const worktree of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(worktree)
    const next = after.get(worktree)
    if (previous === next) {
      continue
    }
    changedWorktrees.push(worktree)
    const diff = diffSessionTabsMembership(previous?.tabs, next?.tabs)
    if (diff.lostTabIds.length > 0 || diff.lostAgentEvidenceTabIds.length > 0) {
      lossWorktrees.push(worktree)
    }
  }
  if (changedWorktrees.length > 0) {
    recordSessionFrameLog({ kind: 'owner.repair', path, changedWorktrees, lossWorktrees })
  }
}

const CLIENT_NAVIGATION_EPOCH_SUFFIX = ':client-navigation'

/** The per-client navigation revision folded into a projected frame's version, when there is one. */
function projectionRevision(frame: Frame, storedVersion: number | undefined): number | null {
  return storedVersion !== undefined &&
    frame.publicationEpoch.endsWith(CLIENT_NAVIGATION_EPOCH_SUFFIX)
    ? frame.snapshotVersion - storedVersion
    : null
}

export function recordOwnerEmittedFrame(
  path: string,
  frame: Frame,
  clientNavigationId: string | undefined,
  changeSequence: number,
  storedVersion?: number
): void {
  recordSessionFrameLog({
    kind: 'owner.emit',
    path,
    client: clientNavigationId ?? null,
    changeSequence,
    ...(storedVersion !== undefined
      ? { storedVersion, projectionRevision: projectionRevision(frame, storedVersion) }
      : {}),
    activeTabId: (frame as { activeTabId?: string | null }).activeTabId ?? null,
    frame: summarizeSessionTabsFrame(frame)
  })
}

const listAllSignatureByClientWorktree = new Map<string, string>()

/** listAll answers are polled; log a workspace's projection only when its revision moved. */
export function recordOwnerListAllEmission(args: {
  stored: ReadonlyMap<string, Snapshot>
  emitted: readonly RuntimeMobileSessionTabsResult[]
  clientNavigationId: string | undefined
  changeSequence: number
  resolveWorkspaceHostId: (worktree: string) => ExecutionHostId | null
}): void {
  const client = args.clientNavigationId ?? ''
  const emittedWorktrees = new Set<string>()
  if (listAllSignatureByClientWorktree.size > DEDUPE_LIMIT) {
    listAllSignatureByClientWorktree.clear()
  }
  for (const frame of args.emitted) {
    emittedWorktrees.add(frame.worktree)
    const storedVersion = args.stored.get(frame.worktree)?.snapshotVersion
    const key = `${client}\u0000${frame.worktree}`
    // Why every part: the projected version folds the stored version and the client's navigation
    // revision together, so a sum can repeat while either one moved.
    const signature = JSON.stringify([
      frame.publicationEpoch,
      frame.snapshotVersion,
      storedVersion ?? null,
      projectionRevision(frame, storedVersion),
      frame.activeTabId,
      frame.tabs.map((tab) => tab.id)
    ])
    if (listAllSignatureByClientWorktree.get(key) !== signature) {
      listAllSignatureByClientWorktree.set(key, signature)
      recordOwnerEmittedFrame(
        'listAll',
        frame,
        args.clientNavigationId,
        args.changeSequence,
        storedVersion
      )
    }
  }
  for (const [worktree, snapshot] of args.stored) {
    if (emittedWorktrees.has(worktree)) {
      continue
    }
    const key = `exclude\u0000${client}\u0000${worktree}`
    const signature = `${snapshot.publicationEpoch}#${snapshot.snapshotVersion}`
    if (listAllSignatureByClientWorktree.get(key) !== signature) {
      listAllSignatureByClientWorktree.set(key, signature)
      recordSessionFrameLog({
        kind: 'owner.exclude',
        path: 'listAll',
        worktree,
        reason: 'workspace-owned-by-paired-runtime',
        workspaceHostId: args.resolveWorkspaceHostId(worktree),
        stored: brief(snapshot)
      })
    }
  }
  for (const [worktree, snapshot] of args.stored) {
    recordOwnerOwnershipInputs(worktree, snapshot, args.resolveWorkspaceHostId(worktree))
  }
}

export function _resetOwnerFrameLogDedupeForTests(): void {
  resetOwnershipDedupeForTests()
  listAllSignatureByClientWorktree.clear()
}
