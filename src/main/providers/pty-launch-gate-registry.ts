import type { PtyLaunchGate } from './pty-launch-gate'
import type { IPtyProvider } from './types'

/** Retains bounded execution receipts after PTY cleanup so reconnect can read the OS observation. */
export class PtyLaunchGateRegistry extends Map<string, PtyLaunchGate> {
  private retired = new Set<string>()

  release: NonNullable<IPtyProvider['releaseLaunchGate']> = async (request) => {
    const gate = this.get(request.gate.ptyId)
    if (!gate) {
      throw new Error('pty_launch_gate_unavailable')
    }
    return gate.release(request)
  }

  readObservation: NonNullable<IPtyProvider['readLaunchGateObservation']> = async (receipt) => {
    const gate = this.get(receipt.ptyId)
    if (!gate) {
      throw new Error('pty_launch_gate_unavailable')
    }
    return gate.readObservation(receipt)
  }

  override set(id: string, gate: PtyLaunchGate): this {
    this.get(id)?.dispose()
    this.retired.delete(id)
    return super.set(id, gate)
  }

  retire(id: string): void {
    const gate = this.get(id)
    gate?.close()
    if (!gate?.retainsProcessObservation) {
      this.delete(id)
      return
    }
    this.retired.add(id)
    while (this.retired.size > 1000) {
      this.delete(this.retired.values().next().value!)
    }
  }

  override delete(id: string): boolean {
    this.get(id)?.dispose()
    this.retired.delete(id)
    return super.delete(id)
  }

  override clear(): void {
    for (const gate of this.values()) {
      gate.dispose()
    }
    this.retired.clear()
    super.clear()
  }
}
