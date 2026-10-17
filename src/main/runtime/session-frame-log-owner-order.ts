// Owner-side session frame log for step 3's decisions (session-count fix): when the window's
// publication kept a surface a runtime reconciler would have dropped, when a retired renderer
// generation was refused, and how each recovery run ended. With the emitted frames' inventory
// order (generation, revision, projection revision) this makes acceptance check A2 measurable.
// Observe-only; each call site checks isSessionFrameLogEnabled() first.

import { recordSessionFrameLog } from '../observability/session-frame-log'
import { DEDUPE_LIMIT } from './session-frame-log-owner'

const windowAuthoritySignatureByWorktree = new Map<string, string>()

/** Logged once per distinct decision per workspace: the reconcile runs on every notify. */
export function recordOwnerWindowAuthorityDecision(args: {
  path: string
  worktree: string
  keptWindowTabIds: readonly string[]
  droppedRuntimeTabIds: readonly string[]
}): void {
  const signature = JSON.stringify([args.path, args.keptWindowTabIds, args.droppedRuntimeTabIds])
  if (windowAuthoritySignatureByWorktree.get(args.worktree) === signature) {
    return
  }
  if (windowAuthoritySignatureByWorktree.size > DEDUPE_LIMIT) {
    windowAuthoritySignatureByWorktree.clear()
  }
  windowAuthoritySignatureByWorktree.set(args.worktree, signature)
  recordSessionFrameLog({
    kind: 'owner.reconcile',
    path: args.path,
    worktree: args.worktree,
    decision: 'kept-window-published',
    reason: 'window-publication-authoritative',
    keptTabIds: [...args.keptWindowTabIds],
    droppedRuntimeTabIds: [...args.droppedRuntimeTabIds]
  })
}

export function recordOwnerRendererGenerationFenced(rendererGeneration: string): void {
  recordSessionFrameLog({
    kind: 'owner.sync',
    decision: 'rejected',
    reason: 'retired-renderer-generation',
    rendererGeneration
  })
}

export function recordOwnerInventoryRecovery(args: {
  reasons: readonly string[]
  outcome: 'committed' | 'superseded'
  changedWorktrees: readonly string[]
  generation: string
  revision: number
}): void {
  recordSessionFrameLog({
    kind: 'owner.recovery',
    reasons: [...args.reasons],
    decision: args.outcome,
    reason: args.outcome === 'superseded' ? 'newer-reconcile-requested' : 'reconciled',
    changedWorktrees: [...args.changedWorktrees],
    generation: args.generation,
    revision: args.revision
  })
}

export function _resetOwnerOrderFrameLogForTests(): void {
  windowAuthoritySignatureByWorktree.clear()
}
