/**
 * A revocable fence for one fenced delivery (`omni session continue`): opened when its prompt
 * starts out, revoked on any change main learns of for that conversation (a hook report, a turn
 * signal, a next-steps change, a chat status), and checked synchronously by main's node-pty writer.
 * Daemon writes check a synchronous file latch registered with this fence, so revocation is visible
 * even to a request already in transit.
 *
 * What no writer can close: the time from the agent's change to main hearing of it (a hook's HTTP
 * post, a chat status event). That
 * is the same irreducible class as the kernel window in `guarded-pty-write.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { ConversationSource } from '../../shared/conversation-source'

type FenceTolerance = {
  /** A hook report on its pane that changes nothing this fence stands for (never human input). */
  toleratesHookReport?: (report: unknown) => boolean
  /** Its pane's turn signals, each derived from a hook report `toleratesHookReport` also judges. */
  toleratesPaneTurns?: boolean
}

type OpenFence = FenceTolerance & {
  source: ConversationSource
  /** Synchronous: the conversation still reads exactly as it was checked. */
  stillHolds: () => boolean
  /** Every PTY a write under this fence was sent to: each hears of a revocation. */
  ptyIds: Set<string>
  invalidators: Set<() => void>
}

const MAX_REVOKED = 4_096
const fences = new Map<string, OpenFence>()
const revoked = new Set<string>()
let revocationSink: ((ptyId: string, token: string) => void) | null = null

/** Where a revocation goes for a PTY another process writes (the terminal daemon). */
export function setWriteFenceRevocationSink(sink: typeof revocationSink): void {
  revocationSink = sink
}

export function openWriteFence(
  source: ConversationSource,
  stillHolds: () => boolean,
  options: FenceTolerance = {}
): string {
  const token = randomUUID()
  fences.set(token, {
    source,
    stillHolds,
    ...(options.toleratesHookReport ? { toleratesHookReport: options.toleratesHookReport } : {}),
    ...(options.toleratesHookReport && options.toleratesPaneTurns
      ? { toleratesPaneTurns: true }
      : {}),
    ptyIds: new Set(),
    invalidators: new Set()
  })
  return token
}

export function closeWriteFence(token: string): void {
  const fence = fences.get(token)
  if (fence) {
    revoke(token, fence)
  }
}

/** The owning daemon's synchronous latch is invalidated on both revoke and close. */
export function registerWriteFenceInvalidator(token: string, invalidate: () => void): () => void {
  const fence = fences.get(token)
  if (!fence || revoked.has(token)) {
    invalidate()
    return () => {}
  }
  fence.invalidators.add(invalidate)
  return () => {
    fence.invalidators.delete(invalidate)
  }
}

/** Open and never revoked; an unknown, closed or revoked token is never open. */
export function isWriteFenceOpen(token: string): boolean {
  return fences.has(token) && !revoked.has(token)
}

/** Called before a write under this fence is sent to `ptyId`, so a later revocation reaches it. */
export function noteWriteFencePty(token: string, ptyId: string): void {
  fences.get(token)?.ptyIds.add(ptyId)
}

function revoke(token: string, fence: OpenFence): void {
  revoked.add(token)
  if (revoked.size > MAX_REVOKED) {
    revoked.delete(revoked.values().next().value!)
  }
  fences.delete(token)
  for (const invalidate of fence.invalidators) {
    invalidate()
  }
  for (const ptyId of fence.ptyIds) {
    try {
      revocationSink?.(ptyId, token)
    } catch {
      // The local check already refuses; a daemon that cannot hear it refuses its next fenced write.
    }
  }
}

export type ConversationInvalidationReason = 'input' | 'hook' | 'turn'
const invalidationListeners = new Set<
  (changed: (source: ConversationSource) => boolean, reason: ConversationInvalidationReason) => void
>()

/** A newly created transfer target also observes activity before its first delivery fence. */
export function onConversationWriteInvalidation(
  listener: (
    changed: (source: ConversationSource) => boolean,
    reason: ConversationInvalidationReason
  ) => void
): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

/** Revokes every open fence on a conversation that changed. */
export function revokeWriteFencesWhere(
  changed: (source: ConversationSource) => boolean,
  reason: ConversationInvalidationReason = 'input',
  /** The hook report behind a `hook` revocation, for a fence that tolerates some. */
  report?: unknown
): void {
  for (const [token, fence] of fences) {
    if (!changed(fence.source)) {
      continue
    }
    let tolerated = false
    try {
      tolerated =
        (reason === 'hook' &&
          report !== undefined &&
          fence.toleratesHookReport?.(report) === true) ||
        (reason === 'turn' && fence.source.kind === 'pty' && fence.toleratesPaneTurns === true)
    } catch {
      tolerated = false
    }
    if (!tolerated) {
      revoke(token, fence)
    }
  }
  for (const listener of invalidationListeners) {
    try {
      listener(changed, reason)
    } catch {
      // Observers cannot prevent fence revocation or keep later observers from seeing activity.
    }
  }
}

/** After a change that names no conversation (the next-steps store): revokes what moved. */
export function recheckWriteFences(): void {
  for (const [token, fence] of fences) {
    let holds = false
    try {
      holds = fence.stillHolds()
    } catch {
      holds = false
    }
    if (!holds) {
      revoke(token, fence)
    }
  }
}
