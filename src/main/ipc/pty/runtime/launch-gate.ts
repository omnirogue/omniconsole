import type {
  PtyLaunchGateObservation,
  PtyLaunchGateReceipt,
  PtyLaunchGateRelease,
  PtyLaunchGateReleased
} from '../../../../shared/pty-launch-gate'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { getProviderForPty } from '../provider/registry'

export async function releasePtyLaunchGateFromRuntimeController(
  request: PtyLaunchGateRelease
): Promise<PtyLaunchGateReleased> {
  const { ptyId, incarnationId } = request.gate
  if (
    ptyId.startsWith('remote:') ||
    parseAppSshPtyId(ptyId) ||
    ptyOwnership.get(ptyId) != null ||
    ptyIncarnationById.get(ptyId) !== incarnationId
  ) {
    throw new Error('pty_launch_gate_identity_unverifiable')
  }
  const provider = getProviderForPty(ptyId)
  if (!provider.releaseLaunchGate) {
    throw new Error('pty_launch_gate_unavailable')
  }
  return provider.releaseLaunchGate(request)
}

/** Read retained host evidence after pane cleanup without treating lost routing as process death. */
export async function readPtyLaunchGateFromRuntimeController(
  gate: PtyLaunchGateReceipt
): Promise<PtyLaunchGateObservation> {
  const unknown = (reason: string): PtyLaunchGateObservation => ({
    gateId: gate.gateId,
    ptyId: gate.ptyId,
    incarnationId: gate.incarnationId,
    pid: gate.pid,
    processStartTimeMs: gate.processStartTimeMs,
    startAcknowledgement: null,
    state: 'unverifiable',
    reason
  })
  if (
    gate.ptyId.startsWith('remote:') ||
    parseAppSshPtyId(gate.ptyId) ||
    ptyOwnership.get(gate.ptyId) != null ||
    (ptyIncarnationById.has(gate.ptyId) &&
      ptyIncarnationById.get(gate.ptyId) !== gate.incarnationId)
  ) {
    return unknown('pty_launch_gate_identity_unverifiable')
  }
  try {
    const provider = getProviderForPty(gate.ptyId)
    if (!provider.readLaunchGateObservation) {
      return unknown('pty_launch_gate_observation_unavailable')
    }
    const observation = await provider.readLaunchGateObservation(gate)
    if (
      observation.gateId !== gate.gateId ||
      observation.ptyId !== gate.ptyId ||
      observation.incarnationId !== gate.incarnationId ||
      observation.pid !== gate.pid ||
      observation.processStartTimeMs !== gate.processStartTimeMs
    ) {
      return unknown('pty_launch_gate_identity_unverifiable')
    }
    return observation
  } catch {
    return unknown('pty_launch_gate_observation_unavailable')
  }
}
