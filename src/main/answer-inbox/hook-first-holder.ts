/**
 * Who holds a conversation's pane, as seen when the claimer looked it up (or a resume opened it).
 * An answer is bound to a pane only if, at handover, the pane still runs that conversation under
 * the same launch (and agent process, when both are known), so a replacement never receives it.
 */

import type { WorkDeliveryDeps, WorkPane } from '../work-delivery/work-delivery-claimer-types'
import type { ClaimableDelivery, WorkDeliveryTarget } from '../work-delivery/work-delivery-kind'
import type { HolderIdentity } from './answer-inbox'
import type { HookFirstRoute } from './hook-first-route'

const LOOKUPS_KEPT = 64

type Lookup = { identity: HolderIdentity; viaResume: boolean }

export type HolderCheck =
  | { kind: 'bind'; identity: HolderIdentity }
  /** No launch recorded for the pane, or no lookup to compare with: typed as today. */
  | { kind: 'untracked' }
  /** The pane changed owner since the lookup: nothing may be sent to it. */
  | { kind: 'changed' }

export function sameOwner(expected: HolderIdentity, now: HolderIdentity): boolean {
  return (
    expected.paneKey === now.paneKey &&
    expected.launchHash === now.launchHash &&
    (expected.agentPid === null || now.agentPid === null || expected.agentPid === now.agentPid)
  )
}

const lookupKey = (ref: string, paneKey: string) => `${ref}\n${paneKey}`

export class HookFirstHolders {
  private readonly lookups = new Map<string, Lookup>()

  constructor(private readonly read?: (pane: WorkPane) => Promise<HolderIdentity | null>) {}

  /** The launch recorded for the pane and its proven agent pid; null when none is recorded. */
  async identity(pane: WorkPane): Promise<HolderIdentity | null> {
    const identity = await this.read?.(pane).catch(() => null)
    return identity?.launchHash ? identity : null
  }

  /** The claimer's holder lookup, remembering who held a live pane while `tracking()`. */
  findHolder(inner: WorkDeliveryDeps, tracking: () => boolean): WorkDeliveryDeps['findHolder'] {
    return async (target) => {
      const holder = await inner.findHolder(target)
      if (holder.kind === 'live' && tracking()) {
        await this.note(target.ref, holder.pane, false)
      }
      return holder
    }
  }

  /** Remembers who held the pane when the conversation was found there (or a resume opened it). */
  async note(ref: string, pane: WorkPane, viaResume: boolean): Promise<HolderIdentity | null> {
    const key = lookupKey(ref, pane.paneKey)
    const identity = await this.identity(pane)
    this.lookups.delete(key)
    if (identity) {
      this.lookups.set(key, { identity, viaResume })
      if (this.lookups.size > LOOKUPS_KEPT) {
        this.lookups.delete(this.lookups.keys().next().value!)
      }
    }
    return identity
  }

  /** At handover: bind to the owner seen at the lookup only if the pane still is that owner. */
  async check(
    inner: Pick<WorkDeliveryDeps, 'findHolder' | 'audit'>,
    target: WorkDeliveryTarget,
    pane: WorkPane,
    about?: ClaimableDelivery
  ): Promise<HolderCheck> {
    const check = await this.compare(inner, target, pane)
    if (check.kind === 'changed' && about) {
      inner.audit(about, `not sent: pane ${pane.paneKey} changed owner since it was looked up`)
    }
    return check
  }

  private async compare(
    inner: Pick<WorkDeliveryDeps, 'findHolder'>,
    target: WorkDeliveryTarget,
    pane: WorkPane
  ): Promise<HolderCheck> {
    const key = lookupKey(target.ref, pane.paneKey)
    const lookup = this.lookups.get(key)
    this.lookups.delete(key)
    const now = await this.identity(pane)
    if (!now || !lookup) {
      return { kind: 'untracked' }
    }
    if (!sameOwner(lookup.identity, now)) {
      return { kind: 'changed' }
    }
    if (!lookup.viaResume) {
      // Why: the same launch can start another conversation; the pane must still run this one.
      const holder = await inner.findHolder(target).catch(() => null)
      if (holder?.kind !== 'live' || holder.pane.paneKey !== pane.paneKey) {
        return { kind: 'changed' }
      }
    }
    return { kind: 'bind', identity: now }
  }
}

/**
 * Wraps resume: the answer is offered first (its SessionStart is the first hook that can carry it),
 * yet no hook may take it until it is bound to the pane and launch this resume opened.
 */
export function resumeThenBind(
  inner: WorkDeliveryDeps,
  holders: HookFirstHolders,
  routes: {
    offer(delivery: ClaimableDelivery, target: WorkDeliveryTarget): HookFirstRoute | null
    bind(route: HookFirstRoute, identity: HolderIdentity): void
    drop(route: HookFirstRoute): void
  }
): WorkDeliveryDeps['resume'] {
  return async (target, reason, delivery) => {
    const route = delivery ? routes.offer(delivery, target) : null
    let pane: WorkPane
    try {
      pane = await inner.resume(target, reason, delivery)
    } catch (error) {
      if (route) {
        routes.drop(route)
      }
      throw error
    }
    const identity = route ? await holders.note(target.ref, pane, true) : null
    if (route && identity) {
      route.pane = pane
      routes.bind(route, identity)
    } else if (route) {
      routes.drop(route)
    }
    return pane
  }
}
