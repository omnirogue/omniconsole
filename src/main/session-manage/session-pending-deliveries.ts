/**
 * Prompts held for a busy session (`omni session continue --prompt|assign … --when-idle`). Each
 * is tried when its target finishes a turn, and on a slow sweep, and sent only once the target is
 * free by `sessionOwnerLoad` (idle, nothing queued or open, nothing waiting on the person, no Keep
 * going, chain or outcome run driving it). Sending is `continue --prompt` (or `assign`) itself, so
 * every guard runs again at that moment. It is marked
 * `delivering` durably before it is sent, so a restart never sends it twice; when its window ends
 * it is reported back unsent, and nothing is launched in its place.
 */

import type { SessionManageEntry } from '../../shared/session-manage-types'
import type {
  SessionPendingDelivery,
  SessionPendingDeliveryState
} from '../../shared/session-pending-delivery-types'
import { isSessionPendingDeliverySettled } from '../../shared/session-pending-delivery-types'
import { remoteExecutionRefusal } from './session-manage-locality'
import { sessionOwnerLoad } from './session-manage-owner-load'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import type { SessionPendingDeliveriesStore } from './session-pending-deliveries-store'

export type SessionPendingDeliveryDeps = {
  store: SessionPendingDeliveriesStore
  /**
   * The target row as `session list` observes it now, and whether a session chain or outcome run
   * drives it; null when no sidebar row holds its pane.
   */
  observe(
    target: SessionPendingDelivery['target']
  ): Promise<{ entry: SessionManageEntry; bound: boolean } | null>
  /** `session continue --prompt` for the held text, with every guard checked again now. */
  deliver(delivery: SessionPendingDelivery): Promise<{ entryId?: string; summary: string }>
  /** The audit line and the window's toast for how it ended. */
  report(delivery: SessionPendingDelivery): void
  now(): number
}

/** Why the target can never take it now (gone, exited, another host), or null. */
function permanentRefusal(entry: SessionManageEntry): string | null {
  const remote = remoteExecutionRefusal(entry, 'continue')
  if (remote) {
    return remote
  }
  return entry.verdict === 'exited'
    ? `“${entry.title}” exited before it was free, so the prompt was not sent.`
    : null
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.round(ms / 60_000))
  return `${count} minute${count === 1 ? '' : 's'}`
}

export class SessionPendingDeliveries {
  private readonly attempts = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Set<(delivery: SessionPendingDelivery) => void>>()

  constructor(private readonly deps: SessionPendingDeliveryDeps) {}

  /** After a restart: a send that was cut off is `unknown`, never retried; the rest are tried. */
  async start(): Promise<void> {
    await this.deps.store.load()
    for (const delivery of this.deps.store.list()) {
      if (delivery.state === 'delivering') {
        await this.settle(
          delivery,
          'unknown',
          `OmniConsole stopped while the prompt for “${delivery.target.title}” was being sent, so whether it arrived is unknown. Check that session before sending it again.`
        )
      }
    }
    await this.sweep()
  }

  async hold(delivery: SessionPendingDelivery): Promise<SessionPendingDelivery> {
    await this.deps.store.add(delivery)
    return delivery
  }

  list(): SessionPendingDelivery[] {
    return this.deps.store.list()
  }

  hasWaiting(): boolean {
    return this.deps.store.list().some((delivery) => delivery.state === 'waiting')
  }

  /** Tries every waiting prompt: expiry first, then readiness. */
  async sweep(): Promise<void> {
    const waiting = this.deps.store.list().filter((delivery) => delivery.state === 'waiting')
    for (const delivery of waiting) {
      await this.check(delivery.id)
    }
  }

  /** A turn finished on this pane: its held prompts are tried now. */
  async noteTurnFinished(paneKey: string): Promise<void> {
    const held = this.deps.store
      .list()
      .filter((delivery) => delivery.state === 'waiting' && delivery.target.paneKey === paneKey)
    for (const delivery of held) {
      await this.check(delivery.id)
    }
  }

  /** One attempt at a time per prompt: a turn signal and the sweep never both send it. */
  check(id: string): Promise<void> {
    const running = this.attempts.get(id)
    if (running) {
      return running
    }
    const attempt = this.attempt(id).finally(() => this.attempts.delete(id))
    this.attempts.set(id, attempt)
    return attempt
  }

  async cancel(id: string): Promise<SessionPendingDelivery> {
    await this.attempts.get(id)
    const delivery = this.deps.store.get(id)
    if (!delivery) {
      throw new Error(`No held prompt ${id}. See omni session pending --all.`)
    }
    if (delivery.state !== 'waiting') {
      throw new Error(`Held prompt ${id} is ${delivery.state} already, so it cannot be cancelled.`)
    }
    return this.settle(
      delivery,
      'cancelled',
      `Cancelled the prompt held for “${delivery.target.title}”; it was not sent.`
    )
  }

  /** Resolves once it is settled, or with its current state when `signal` aborts. */
  waitFor(id: string, signal?: AbortSignal): Promise<SessionPendingDelivery> {
    const current = this.deps.store.get(id)
    if (!current) {
      return Promise.reject(new Error(`No held prompt ${id}.`))
    }
    if (isSessionPendingDeliverySettled(current)) {
      return Promise.resolve(current)
    }
    return new Promise((resolve) => {
      const listeners = this.waiters.get(id) ?? new Set()
      const done = (delivery: SessionPendingDelivery): void => {
        listeners.delete(done)
        resolve(delivery)
      }
      listeners.add(done)
      this.waiters.set(id, listeners)
      signal?.addEventListener(
        'abort',
        () => {
          listeners.delete(done)
          resolve(this.deps.store.get(id) ?? current)
        },
        { once: true }
      )
    })
  }

  private async attempt(id: string): Promise<void> {
    const delivery = this.deps.store.get(id)
    if (delivery?.state !== 'waiting') {
      return
    }
    const name = `“${delivery.target.title}”`
    if (this.deps.now() >= delivery.expiresAt) {
      await this.settle(
        delivery,
        'expired',
        `${name} was not free within ${minutes(delivery.expiresAt - delivery.createdAt)}, so the prompt was not sent and nothing was launched in its place. Decide what to do with it.`
      )
      return
    }
    let observed: { entry: SessionManageEntry; bound: boolean } | null
    try {
      observed = await this.deps.observe(delivery.target)
    } catch (error) {
      await this.note(
        delivery,
        `Could not read ${name} (${error instanceof Error ? error.message : String(error)}); trying again.`
      )
      return
    }
    if (!observed) {
      await this.settle(
        delivery,
        'refused',
        `No sidebar row holds pane ${delivery.target.paneKey} any more, so the prompt for ${name} was not sent.`
      )
      return
    }
    const refusal = permanentRefusal(observed.entry)
    if (refusal) {
      await this.settle(delivery, 'refused', refusal)
      return
    }
    // The same free rule `session assign` and `find-owner` use, chain ownership included.
    const load = sessionOwnerLoad(observed.entry, observed.bound)
    if (!load.light) {
      await this.note(delivery, `Waiting: ${load.words}.`)
      return
    }
    try {
      await this.deps.store.update(id, { state: 'delivering' })
    } catch {
      // Not recorded as sending, so it is not sent: the next attempt tries again.
      return
    }
    try {
      const sent = await this.deps.deliver(delivery)
      await this.settle(delivery, 'delivered', sent.summary, sent.entryId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof SessionManagePartialError) {
        await this.settle(delivery, 'unknown', message)
        return
      }
      // A refusal at this moment (its reply asks something, a draft in its input) leaves it held.
      await this.deps.store
        .update(id, {
          state: 'waiting',
          note:
            error instanceof SessionManageRefusal ? `Not yet: ${message}` : `Not yet (${message}).`
        })
        .catch(() => {})
    }
  }

  private async note(delivery: SessionPendingDelivery, note: string): Promise<void> {
    if (delivery.note !== note) {
      await this.deps.store.update(delivery.id, { note }).catch(() => {})
    }
  }

  private async settle(
    delivery: SessionPendingDelivery,
    state: SessionPendingDeliveryState,
    note: string,
    entryId?: string
  ): Promise<SessionPendingDelivery> {
    const patch = { state, note, settledAt: this.deps.now(), ...(entryId ? { entryId } : {}) }
    const settled = await this.deps.store
      .update(delivery.id, patch)
      .catch(() => ({ ...delivery, ...patch }))
    this.deps.report(settled)
    for (const listener of this.waiters.get(delivery.id) ?? []) {
      listener(settled)
    }
    this.waiters.delete(delivery.id)
    return settled
  }
}
