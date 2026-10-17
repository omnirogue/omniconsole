// One ordering contract for session-tab inventory (session-count fix, step 3). The owner stamps
// every published snapshot and every removal tombstone with its runtime incarnation (generation)
// and one monotonic inventory revision shared by all of its writers; a client's own navigation and
// closed-tab projection carries a separate revision. Receivers that negotiated the metadata order
// frames by it instead of by publication epochs, which change on renderer reload, headless creation
// and activation, and so cannot tell a delayed older frame from a newer one.

import { SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY } from './protocol-version'

/** Negotiated, additive metadata on a session-tabs snapshot or removal frame. */
export type SessionTabsInventoryOrder = {
  /**
   * One per runtime incarnation; a restart mints a new one. Opaque and unordered on purpose: an
   * owner's wall clock can step backwards across a restart, so receivers never compare two
   * generations, they retire the one a fresh connection replaced.
   */
  generation: string
  /** Monotonic within the generation across every writer and every removal tombstone. */
  revision: number
  /** The receiving client's navigation/closed-tab projection revision; absent when unprojected. */
  projectionRevision?: number
}

export type SessionTabsInventoryOrderReason =
  | 'newer-generation'
  | 'newer-inventory-revision'
  | 'newer-client-projection'
  | 'retired-generation'
  | 'older-inventory-revision'
  | 'older-client-projection'
  | 'same-inventory-revision'

export type SessionTabsInventoryOrderVerdict = {
  readonly apply: boolean
  readonly reason: SessionTabsInventoryOrderReason
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Reads the metadata from an untrusted frame; anything malformed reads as absent (legacy). */
export function readSessionTabsInventoryOrder(frame: unknown): SessionTabsInventoryOrder | null {
  if (!frame || typeof frame !== 'object') {
    return null
  }
  const order = (frame as { inventoryOrder?: unknown }).inventoryOrder
  if (!order || typeof order !== 'object') {
    return null
  }
  const { generation, revision, projectionRevision } = order as Partial<
    Record<keyof SessionTabsInventoryOrder, unknown>
  >
  if (
    typeof generation !== 'string' ||
    generation.length === 0 ||
    generation.length > 128 ||
    !isNonNegativeInteger(revision) ||
    (projectionRevision !== undefined && !isNonNegativeInteger(projectionRevision))
  ) {
    return null
  }
  return {
    generation,
    revision,
    ...(projectionRevision !== undefined ? { projectionRevision } : {})
  }
}

/**
 * Orders an incoming frame against the last one accepted for the same (owner, workspace).
 * Why the projection revision only breaks ties: a frame with a newer inventory revision already
 * carries the client's current projection (both are read at emission), so navigation is never lost,
 * while a navigation-only change at the same inventory revision still advances.
 */
export function compareSessionTabsInventoryOrder(
  incoming: SessionTabsInventoryOrder,
  current: SessionTabsInventoryOrder,
  isRetiredGeneration: (generation: string) => boolean = () => false
): SessionTabsInventoryOrderVerdict {
  if (incoming.generation !== current.generation) {
    // Why: any generation not yet retired is accepted; the receiver retires the one it replaced
    // once the new one arrives on a fresh connection, so a delayed frame of it cannot return.
    return isRetiredGeneration(incoming.generation)
      ? { apply: false, reason: 'retired-generation' }
      : { apply: true, reason: 'newer-generation' }
  }
  if (incoming.revision !== current.revision) {
    return incoming.revision > current.revision
      ? { apply: true, reason: 'newer-inventory-revision' }
      : { apply: false, reason: 'older-inventory-revision' }
  }
  const incomingProjection = incoming.projectionRevision ?? 0
  const currentProjection = current.projectionRevision ?? 0
  if (incomingProjection !== currentProjection) {
    return incomingProjection > currentProjection
      ? { apply: true, reason: 'newer-client-projection' }
      : { apply: false, reason: 'older-client-projection' }
  }
  return { apply: false, reason: 'same-inventory-revision' }
}

/** Strips the metadata for a client that did not negotiate it, so it sees today's frame exactly. */
export function withoutSessionTabsInventoryOrder<T extends object>(frame: T): T {
  if (!Object.prototype.propertyIsEnumerable.call(frame, 'inventoryOrder')) {
    return frame
  }
  const { inventoryOrder: _inventoryOrder, ...rest } = frame as T & { inventoryOrder?: unknown }
  return rest as T
}

/**
 * Inside the owner the order rides as a non-enumerable property: in-process results, structured
 * clones and JSON stay exactly today's frame, and only the RPC projection publishes it, to a
 * client that negotiated it. Spreads drop it, so each projection step carries it explicitly.
 */
export function attachSessionTabsInventoryOrder<T extends object>(
  frame: T,
  order: SessionTabsInventoryOrder | null
): T {
  if (order) {
    Object.defineProperty(frame, 'inventoryOrder', {
      value: order,
      enumerable: false,
      configurable: true,
      writable: true
    })
  }
  return frame
}

export function carrySessionTabsInventoryOrder<T extends object>(from: object, to: T): T {
  if (to === from || readSessionTabsInventoryOrder(to)) {
    return to
  }
  return attachSessionTabsInventoryOrder(to, readSessionTabsInventoryOrder(from))
}

/**
 * Step 3c: a client's navigation/closed-tab revision rides beside the shared inventory revision
 * instead of only inside the folded version, so a receiver orders it separately and a
 * navigation-only change is never discarded as a stale inventory frame.
 */
export function withSessionTabsProjectionRevision<T extends object>(
  source: object,
  projectionRevision: number,
  projected: T
): T {
  const order = readSessionTabsInventoryOrder(source)
  return attachSessionTabsInventoryOrder(projected, order ? { ...order, projectionRevision } : null)
}

/** The RPC boundary: a negotiating client gets the order as an ordinary field, others never. */
export function publishSessionTabsInventoryOrder<T extends object>(
  source: object,
  projected: T,
  clientCapabilities: readonly string[] | undefined
): T {
  const negotiated =
    clientCapabilities?.includes(SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY) === true
  const order = negotiated ? readSessionTabsInventoryOrder(source) : null
  return order
    ? { ...projected, inventoryOrder: order }
    : withoutSessionTabsInventoryOrder(projected)
}

/** Generations (runtime incarnations or renderer generations) that must never be accepted again. */
export class RetiredSessionTabsGenerations {
  private readonly retired = new Set<string>()

  constructor(private readonly limit = 64) {}

  retire(generation: string): void {
    this.retired.delete(generation)
    this.retired.add(generation)
    // Why bounded: one entry per restart or renderer reload; the oldest is long past delivery.
    while (this.retired.size > this.limit) {
      const oldest = this.retired.values().next().value
      if (oldest === undefined) {
        break
      }
      this.retired.delete(oldest)
    }
  }

  has(generation: string): boolean {
    return this.retired.has(generation)
  }

  clear(): void {
    this.retired.clear()
  }
}
