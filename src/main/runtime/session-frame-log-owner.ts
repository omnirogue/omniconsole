// Owner-side session frame log (session-count fix, step 0): the stored mobile-session snapshot
// map, the renderer-sync merge, the listAll repair path and every emitted projection, recorded so
// a transition that loses membership or agent evidence can be traced to the writer that made it.
// Observe-only: nothing here feeds back into a decision, and each hook is one boolean check when off.

import { parseExecutionHostId } from '../../shared/execution-host'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  classifyFrameLogPtyKind,
  countBy,
  diffSessionTabsMembership,
  summarizeSessionTabsFrame
} from '../../shared/session-frame-log'
import { isSessionFrameLogEnabled, recordSessionFrameLog } from '../observability/session-frame-log'

type Snapshot = RuntimeMobileSessionTabsSnapshot
type Frame = Snapshot | RuntimeMobileSessionTabsResult

export const DEDUPE_LIMIT = 4096
/** `new Error().stack` lines before the writer: the message, then the map method's own frame.
 *  Why a count, not names: the main bundle is minified, so frames are positions (see log.start). */
const WRITER_STACK_LEADING_LINES = 2
const WRITER_STACK_DEPTH = 16

export function brief(
  snapshot: Frame | undefined
): { epoch: string; version: number; tabCount: number } | null {
  return snapshot
    ? {
        epoch: snapshot.publicationEpoch,
        version: snapshot.snapshotVersion,
        tabCount: snapshot.tabs.length
      }
    : null
}

/** Why a stack: the producer of C2's churn is unidentified, and the writer's frames name it. */
function writerFrames(origin: Error): string[] {
  return (origin.stack?.split('\n') ?? [])
    .slice(WRITER_STACK_LEADING_LINES, WRITER_STACK_LEADING_LINES + 10)
    .map((line) => line.trim().replace(/^at /, ''))
    .map((line) => line.replace(/\((?:.*[\\/])?([^\\/()]+:\d+:\d+)\)$/, '($1)'))
}

function recordOwnerStoreWrite(
  worktree: string,
  previous: Snapshot | undefined,
  next: Snapshot | undefined,
  origin: Error,
  inventoryRevision: number | null
): void {
  if (previous === next) {
    return
  }
  const diff = diffSessionTabsMembership(previous?.tabs, next?.tabs)
  const epochChanged = previous?.publicationEpoch !== next?.publicationEpoch
  const loss = diff.lostTabIds.length > 0 || diff.lostAgentEvidenceTabIds.length > 0
  // Why: a version-only bump with the same membership and evidence is the steady status stream.
  if (previous && next && !loss && diff.addedTabIds.length === 0 && !epochChanged) {
    return
  }
  recordSessionFrameLog({
    kind: 'owner.store',
    worktree,
    op: next ? (previous ? 'replace' : 'create') : 'delete',
    before: brief(previous),
    after: brief(next),
    // Why (step 3, A2): the shared inventory revision this write was stamped with.
    ...(inventoryRevision !== null ? { inventoryRevision } : {}),
    ...diff,
    loss,
    ...(loss || epochChanged ? { writer: writerFrames(origin) } : {})
  })
}

/** Step 3: told about every stored-snapshot write so one revision counter covers every writer. */
export type MobileSessionTabsWriteObserver = {
  onSet(key: string, previous: Snapshot | undefined, next: Snapshot): number | null
  onDelete(key: string): number
}

/**
 * The stored-snapshot map. Every writer replaces entries (snapshots are immutable), so observing
 * set/delete sees every owner transition, including hydration and preservation paths.
 */
export class FrameLoggedMobileSessionTabsMap extends Map<string, Snapshot> {
  writeObserver: MobileSessionTabsWriteObserver | null = null

  override set(key: string, value: Snapshot): this {
    if (!isSessionFrameLogEnabled()) {
      const previous = this.writeObserver ? super.get(key) : undefined
      super.set(key, value)
      this.writeObserver?.onSet(key, previous, value)
      return this
    }
    // Why built here, not in a helper: the writer is then exactly one frame below this method.
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = WRITER_STACK_DEPTH
    const origin = new Error('session frame log writer')
    Error.stackTraceLimit = limit
    const previous = super.get(key)
    super.set(key, value)
    const revision = this.writeObserver?.onSet(key, previous, value) ?? null
    recordOwnerStoreWrite(key, previous, value, origin, revision)
    return this
  }

  override delete(key: string): boolean {
    if (!isSessionFrameLogEnabled()) {
      const deleted = super.delete(key)
      if (deleted) {
        this.writeObserver?.onDelete(key)
      }
      return deleted
    }
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = WRITER_STACK_DEPTH
    const origin = new Error('session frame log writer')
    Error.stackTraceLimit = limit
    const previous = super.get(key)
    const deleted = super.delete(key)
    if (deleted) {
      const revision = this.writeObserver?.onDelete(key) ?? null
      recordOwnerStoreWrite(key, previous, undefined, origin, revision)
    }
    return deleted
  }
}

function tabIds(snapshot: Frame | undefined): Set<string> {
  return new Set((snapshot?.tabs ?? []).map((tab) => tab.id))
}

const ownershipSignatureByWorktree = new Map<string, string>()

/** The publication predicates' inputs for one workspace, once and again only when they change. */
export function recordOwnerOwnershipInputs(
  worktree: string,
  snapshot: Snapshot | undefined,
  workspaceHostId: ExecutionHostId | null
): void {
  const inputs = {
    workspaceHostId,
    workspaceHostKind: parseExecutionHostId(workspaceHostId)?.kind ?? null,
    terminalPtyKinds: countBy(
      (snapshot?.tabs ?? []).flatMap((tab) =>
        tab.type === 'terminal' ? [classifyFrameLogPtyKind(tab.ptyId)] : []
      )
    )
  }
  const signature = JSON.stringify(inputs)
  if (ownershipSignatureByWorktree.get(worktree) === signature) {
    return
  }
  if (ownershipSignatureByWorktree.size > DEDUPE_LIMIT) {
    ownershipSignatureByWorktree.clear()
  }
  ownershipSignatureByWorktree.set(worktree, signature)
  recordSessionFrameLog({ kind: 'owner.ownership', worktree, ...inputs })
}

export type OwnerSyncFrameLog = {
  skipped(incoming: Snapshot, reason: string): void
  merged(
    incoming: Snapshot,
    fenced: Snapshot,
    stored: Snapshot,
    previous: Snapshot | undefined
  ): void
  omitted(
    worktree: string,
    previous: Snapshot,
    decision: 'preserved' | 'preserved-unchanged' | 'removed',
    preserved?: Snapshot
  ): void
  finish(args: {
    stored: ReadonlyMap<string, Snapshot>
    changed: ReadonlySet<string>
    resyncRequested: ReadonlySet<string>
    unchangedCount: number
    headless: boolean
    resolveWorkspaceHostId: (worktree: string) => ExecutionHostId | null
  }): void
}

/** null when the log is off, so the sync path's hooks are `frameLog?.…` no-ops. */
export function beginOwnerSyncFrameLog(incomingCount: number): OwnerSyncFrameLog | null {
  if (!isSessionFrameLogEnabled()) {
    return null
  }
  return {
    skipped(incoming, reason) {
      recordSessionFrameLog({
        kind: 'owner.sync.frame',
        worktree: incoming.worktree,
        decision: 'skipped',
        reason,
        incoming: summarizeSessionTabsFrame(incoming)
      })
    },
    merged(incoming, fenced, stored, previous) {
      const fencedIds = tabIds(fenced)
      const diff = diffSessionTabsMembership(previous?.tabs, stored.tabs)
      recordSessionFrameLog({
        kind: 'owner.sync.frame',
        worktree: incoming.worktree,
        decision: 'merged',
        reason: previous ? 'renderer-revision' : 'first-renderer-publication',
        incoming: summarizeSessionTabsFrame(incoming),
        fencedOutTabIds: incoming.tabs.map((tab) => tab.id).filter((id) => !fencedIds.has(id)),
        previous: brief(previous),
        stored: summarizeSessionTabsFrame(stored),
        preservedTabIds: stored.tabs.map((tab) => tab.id).filter((id) => !fencedIds.has(id)),
        ...diff,
        loss: diff.lostTabIds.length > 0 || diff.lostAgentEvidenceTabIds.length > 0
      })
    },
    omitted(worktree, previous, decision, preserved) {
      const diff = diffSessionTabsMembership(previous.tabs, preserved?.tabs)
      recordSessionFrameLog({
        kind: 'owner.sync.omitted',
        worktree,
        decision,
        previous: brief(previous),
        ...(preserved ? { preservedTabIds: preserved.tabs.map((tab) => tab.id) } : {}),
        ...diff,
        loss: diff.lostTabIds.length > 0 || diff.lostAgentEvidenceTabIds.length > 0
      })
    },
    finish({ stored, changed, resyncRequested, unchangedCount, headless, resolveWorkspaceHostId }) {
      recordSessionFrameLog({
        kind: 'owner.sync',
        incomingWorktrees: incomingCount,
        unchangedWorktrees: unchangedCount,
        resyncRequested: [...resyncRequested],
        changedWorktrees: [...changed],
        headless
      })
      for (const worktree of changed) {
        recordOwnerOwnershipInputs(worktree, stored.get(worktree), resolveWorkspaceHostId(worktree))
      }
    }
  }
}

export function resetOwnershipDedupeForTests(): void {
  ownershipSignatureByWorktree.clear()
}
