// Receiver half of step 3's ordering contract (session-count fix). When an owner negotiated
// inventory-order metadata, its frames are ordered by (generation, revision, projection revision)
// instead of by publication epoch, so a delayed older frame, a delayed list response, a frame from
// a retired runtime incarnation or one from before a removal can no longer replace newer state.
// Frames without the metadata (an older owner, or a receiver-synthesized frame) keep today's
// epoch/version ordering: this module then answers null and the caller decides as before.
//
// Generations are opaque: an owner's clock can step backwards across a restart, so two are never
// compared. Any unretired generation is accepted; the one it replaced is retired once the new one
// arrives on a fresh connection (a runtime restart always reconnects), so its delayed frames stay
// out. A different generation on the same connection is accepted without retiring, so an
// anomalous frame can never freeze the live incarnation out.

import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { isUnpublishedWorkspacePlaceholder } from '../../../shared/session-tabs-absence-evidence'
import {
  compareSessionTabsInventoryOrder,
  readSessionTabsInventoryOrder,
  RetiredSessionTabsGenerations,
  type SessionTabsInventoryOrder,
  type SessionTabsInventoryOrderReason
} from '../../../shared/session-tabs-inventory-order'

export type OrderedSessionTabsFrameVerdict = {
  readonly apply: boolean
  readonly reason: SessionTabsInventoryOrderReason
  /** What the frame was ordered against; null when only a retired generation fenced it. */
  readonly prior: SessionTabsInventoryOrder | null
}

// Why: placeholders and receiver-synthesized removals are never owner frames; even one that
// carried copied metadata must stay on step 6's removal/unknown path, never be ordered as a newer
// frame. The placeholder is read by step 6's shared recognizer; the synthesized removals come from
// web-session-tabs-sync.ts (visibility-inventory-removal) and web-session-mirror-retraction.ts
// (environment-retired), which build them from scratch without the navigation suffix.
const SYNTHESIZED_REMOVAL_EPOCHS = new Set(['visibility-inventory-removal', 'environment-retired'])

type GenerationRecord = { generation: string; connectionGeneration: number }

const acceptedOrderByKey = new Map<string, SessionTabsInventoryOrder>()
// Why kept past the receiver's tracking reset: a removal clears tracking, and a delayed frame from
// before it must not read as a first frame and resurrect the removed rows.
const tombstoneOrderByKey = new Map<string, SessionTabsInventoryOrder>()
// Why: after a tracking reset the same revision must be accepted again (it re-reads as a first
// frame), but a strictly older one still must not.
const floorOrderByKey = new Map<string, SessionTabsInventoryOrder>()
const currentGenerationByEnvironment = new Map<string, GenerationRecord>()
const retiredGenerationsByEnvironment = new Map<string, RetiredSessionTabsGenerations>()
let lastVerdict: OrderedSessionTabsFrameVerdict | null = null

function orderKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

function retiredGenerations(environmentId: string): RetiredSessionTabsGenerations {
  let retired = retiredGenerationsByEnvironment.get(environmentId)
  if (!retired) {
    retired = new RetiredSessionTabsGenerations()
    retiredGenerationsByEnvironment.set(environmentId, retired)
  }
  return retired
}

/** The frame's order, or null for legacy frames, placeholders and synthesized removals. */
export function readOrderedSessionTabsFrame(
  snapshot: RuntimeMobileSessionTabsResult
): SessionTabsInventoryOrder | null {
  return isUnpublishedWorkspacePlaceholder(snapshot) ||
    SYNTHESIZED_REMOVAL_EPOCHS.has(snapshot.publicationEpoch)
    ? null
    : readSessionTabsInventoryOrder(snapshot)
}

function remember(verdict: OrderedSessionTabsFrameVerdict): OrderedSessionTabsFrameVerdict {
  lastVerdict = verdict
  return verdict
}

/**
 * Null when ordering by metadata does not apply: the frame carries none, or this receiver holds no
 * ordered history for that owner's workspace (first frame, or an older owner's frames so far).
 */
export function decideOrderedSessionTabsFrame(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): OrderedSessionTabsFrameVerdict | null {
  lastVerdict = null
  const incoming = readOrderedSessionTabsFrame(snapshot)
  if (!incoming) {
    return null
  }
  const key = orderKey(environmentId, snapshot.worktree)
  const retired = retiredGenerations(environmentId)
  const isRetired = (generation: string): boolean => retired.has(generation)
  if (isRetired(incoming.generation)) {
    return remember({ apply: false, reason: 'retired-generation', prior: null })
  }
  const prior = acceptedOrderByKey.get(key) ?? tombstoneOrderByKey.get(key)
  if (prior && prior.generation === incoming.generation) {
    return remember({ ...compareSessionTabsInventoryOrder(incoming, prior, isRetired), prior })
  }
  const current = currentGenerationByEnvironment.get(environmentId)
  if (prior || (current && current.generation !== incoming.generation)) {
    return remember({ apply: true, reason: 'newer-generation', prior: prior ?? null })
  }
  const floor = floorOrderByKey.get(key)
  if (floor) {
    const verdict = compareSessionTabsInventoryOrder(incoming, floor, isRetired)
    if (!verdict.apply && verdict.reason !== 'same-inventory-revision') {
      return remember({ ...verdict, prior: floor })
    }
  }
  return null
}

/**
 * Arrival-order gates (latest received, recovery supersession) consult this when both frames are
 * ordered: 'older' / 'not-older' by the owner's order, 'unknown' for two unretired generations.
 */
export function compareOrderedSessionTabsReceipts(
  environmentId: string,
  incoming: SessionTabsInventoryOrder | null,
  latest: SessionTabsInventoryOrder | null | undefined
): 'older' | 'not-older' | 'unknown' {
  if (!incoming || !latest) {
    return 'unknown'
  }
  const retired = retiredGenerations(environmentId)
  if (incoming.generation !== latest.generation) {
    if (retired.has(incoming.generation)) {
      return 'older'
    }
    return retired.has(latest.generation) ? 'not-older' : 'unknown'
  }
  const verdict = compareSessionTabsInventoryOrder(incoming, latest)
  return verdict.apply || verdict.reason === 'same-inventory-revision' ? 'not-older' : 'older'
}

/** Records an applied frame's order; a removal becomes the workspace's tombstone. */
export function recordAcceptedOrderedSessionTabsFrame(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  removed: boolean,
  connectionGeneration: number
): void {
  const order = readOrderedSessionTabsFrame(snapshot)
  if (!order) {
    return
  }
  const current = currentGenerationByEnvironment.get(environmentId)
  if (!current || current.generation !== order.generation) {
    // Why: only a fresh connection proves the replaced incarnation is gone; on the same
    // connection neither is known to be newer, so nothing is retired (no freeze-out).
    if (current && connectionGeneration > current.connectionGeneration) {
      retiredGenerations(environmentId).retire(current.generation)
    }
    currentGenerationByEnvironment.set(environmentId, {
      generation: order.generation,
      connectionGeneration
    })
  }
  const key = orderKey(environmentId, snapshot.worktree)
  floorOrderByKey.delete(key)
  if (removed) {
    acceptedOrderByKey.delete(key)
    tombstoneOrderByKey.set(key, order)
    return
  }
  acceptedOrderByKey.set(key, order)
}

/** The verdict of the last decide call, for the frame log only. */
export function takeLastOrderedSessionTabsVerdict(): OrderedSessionTabsFrameVerdict | null {
  const verdict = lastVerdict
  lastVerdict = null
  return verdict
}

function lowerToFloor(key: string): void {
  const accepted = acceptedOrderByKey.get(key)
  if (accepted) {
    acceptedOrderByKey.delete(key)
    floorOrderByKey.set(key, accepted)
  }
}

/** Mirrors the receiver's tracking reset for one workspace; the tombstone stays. */
export function forgetOrderedSessionTabsWorktree(environmentId: string, worktreeId: string): void {
  lowerToFloor(orderKey(environmentId, worktreeId))
}

/**
 * Mirrors the receiver's tracking reset for a whole environment: its next inventory must read as
 * first frames (the same revision is accepted again), exactly as the epoch/version freshness it
 * shadows does. Floors, tombstones and retired generations keep delayed older frames out.
 */
export function forgetOrderedSessionTabsEnvironment(environmentId: string): void {
  const prefix = `${environmentId}:`
  // Why safe: deleting the entry being visited never skips a Map iterator's remaining keys.
  for (const key of acceptedOrderByKey.keys()) {
    if (key.startsWith(prefix)) {
      lowerToFloor(key)
    }
  }
}

export function resetSessionTabsInventoryOrderForTests(): void {
  acceptedOrderByKey.clear()
  tombstoneOrderByKey.clear()
  floorOrderByKey.clear()
  currentGenerationByEnvironment.clear()
  retiredGenerationsByEnvironment.clear()
  lastVerdict = null
}
