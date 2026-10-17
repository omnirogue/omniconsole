import type { PtyLaunchGateRequest } from '../../shared/pty-launch-gate'
import { PtyLaunchGate } from '../providers/pty-launch-gate'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

export function installSessionLaunchGate(
  session: Session,
  subprocess: SubprocessHandle,
  request: PtyLaunchGateRequest,
  command: string
): PtyLaunchGate {
  const gate = new PtyLaunchGate({
    request,
    command,
    ptyId: session.sessionId,
    incarnationId: session.incarnationId,
    pid: subprocess.pid,
    reportsChildExitStatus: subprocess.reportsChildExitStatus === true,
    shellOwner: subprocess,
    shellPath: subprocess.shellPath,
    isLive: () => session.isAlive && !session.isTerminating,
    write: subprocess.write.bind(subprocess)
  })
  subprocess.write = gate.write
  return gate
}
