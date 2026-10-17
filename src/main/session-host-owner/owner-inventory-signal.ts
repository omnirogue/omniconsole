/**
 * "Something the owner's persisted inventory or PTY liveness depends on changed" (session parity,
 * step 3, addendum F6): the runtime notes a store write or a PTY spawn or exit here, and the
 * main-authored conversation ledger, which coalesces, rebuilds. A listener that throws never stops
 * the runtime path that noted the change, nor the other listeners.
 */
export class OwnerInventorySignal {
  private readonly listeners = new Set<() => void>()
  private connectedPtys: string | null = null

  /**
   * Notifies when the PTYs connected now differ from those this last saw (F16: `live` is PTY
   * connectedness), for a path that flips `connected` with no store write or exit event: the
   * controller inventory refresh, both ways.
   */
  noteConnectedPtys(ptys: Iterable<{ ptyId: string; connected: boolean }>): void {
    const connected = [...ptys]
      .flatMap((pty) => (pty.connected ? [pty.ptyId] : []))
      .sort()
      .join('\0')
    if (connected !== this.connectedPtys) {
      this.connectedPtys = connected
      this.notify()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[session-host] an owner inventory listener failed', error)
      }
    }
  }
}
