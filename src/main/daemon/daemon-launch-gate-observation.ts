import type { IPtyProvider } from '../providers/types'
import type { PtyLaunchGateObservation, PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'

export async function readDaemonLaunchGateObservation(
  adapters: readonly IPtyProvider[],
  receipt: PtyLaunchGateReceipt
): Promise<PtyLaunchGateObservation> {
  // Ordinary live routing forgets exits; the owning host alone can validate this retained receipt.
  for (const adapter of adapters) {
    if (!adapter.supportsLaunchGateObservation?.() || !adapter.readLaunchGateObservation) {
      continue
    }
    try {
      const observed = await adapter.readLaunchGateObservation(receipt)
      if (
        observed.gateId === receipt.gateId &&
        observed.ptyId === receipt.ptyId &&
        observed.incarnationId === receipt.incarnationId &&
        observed.pid === receipt.pid &&
        observed.processStartTimeMs === receipt.processStartTimeMs
      ) {
        return observed
      }
    } catch {
      // Missing/unreachable owners provide no exit evidence.
    }
  }
  throw new Error('pty_launch_gate_observation_unverifiable')
}
