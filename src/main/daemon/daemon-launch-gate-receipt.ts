import { isPtyLaunchGateReceipt, type PtyLaunchGateRequest } from '../../shared/pty-launch-gate'
import type { DaemonCreateOrAttachResult } from './daemon-create-or-attach-result'

export function assertDaemonLaunchGateReceipt(
  request: PtyLaunchGateRequest | undefined,
  result: DaemonCreateOrAttachResult,
  sessionId: string
): void {
  if (
    request &&
    (!isPtyLaunchGateReceipt(result.launchGate) ||
      result.launchGate.launchId !== request.launchId ||
      result.launchGate.ptyId !== (result.agentSessionEnsure?.owner.ptyId ?? sessionId) ||
      result.launchGate.incarnationId !== result.incarnationId ||
      (result.launchGate.ptyRootPid ?? result.launchGate.pid) !== result.pid ||
      (request.processObservation === 'required' &&
        result.launchGate.exitObserver !== 'macos-kqueue'))
  ) {
    throw new Error('pty_launch_gate_identity_unverifiable')
  }
}
