import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

/**
 * Every authenticated local hook event as it arrives (before suppression or interception), and
 * an epoch that changes whenever the server may have missed one: a start, a stop, a failed POST.
 * Also what the server's start drained from the spool (events hooks wrote while it was away) and
 * each POST it failed to take, which evidence kept across app runs must hear about at once.
 */
export class HookEventTap {
  private epoch = 0
  private readonly listeners = new Set<(event: AgentHookEventPayload) => void>()
  private readonly lostListeners = new Set<() => void>()
  private readonly drainedAt = new Map<string, number>()
  private readonly connectionEpochs = new Map<string, number>()

  subscribe(listener: (event: AgentHookEventPayload) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A POST the server failed to take: some pane's event may be gone, and nothing says whose. */
  subscribeLost(listener: () => void): () => void {
    this.lostListeners.add(listener)
    return () => {
      this.lostListeners.delete(listener)
    }
  }

  continuityEpoch(): number {
    return this.epoch
  }

  gap(): void {
    this.epoch += 1
  }

  /** Changes when an SSH transport is lost: its events may have been missed or only replayed. */
  connectionEpoch(connectionId: string): number {
    return this.connectionEpochs.get(connectionId) ?? 0
  }

  connectionGap(connectionId: string): void {
    this.connectionEpochs.set(connectionId, this.connectionEpoch(connectionId) + 1)
  }

  lost(): void {
    this.gap()
    for (const listener of this.lostListeners) {
      try {
        listener()
      } catch (error) {
        console.error('[agent-hooks] lost-event listener failed', error)
      }
    }
  }

  noteDrained(paneKey: string, receivedAt: number): void {
    const at = Number.isFinite(receivedAt) ? receivedAt : Number.POSITIVE_INFINITY
    this.drainedAt.set(paneKey, Math.max(this.drainedAt.get(paneKey) ?? at, at))
  }

  /** A hook in this pane wrote an event at or after `sinceMs` that reached this run only via the spool. */
  drainedSince(paneKey: string, sinceMs: number): boolean {
    return (this.drainedAt.get(paneKey) ?? Number.NEGATIVE_INFINITY) >= sinceMs
  }

  emit(event: AgentHookEventPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[agent-hooks] hook event listener failed', error)
      }
    }
  }
}
