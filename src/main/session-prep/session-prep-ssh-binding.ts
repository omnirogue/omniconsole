import type { SshTarget } from '../../shared/ssh-types'
import { SessionPrepHostError } from './session-prep-execution-host'

export function sessionPrepSshBinding(connectionId: string, targets: readonly SshTarget[]) {
  const target = targets.find((entry) => entry.id === connectionId)
  if (!target) {
    throw new SessionPrepHostError('The SSH target is no longer registered.')
  }
  return {
    connectionGeneration: target.generation,
    connectionBinding: JSON.stringify([
      target.configHost,
      target.host,
      target.port,
      target.username,
      target.identityFile,
      target.identityAgent,
      target.identitiesOnly,
      target.proxyCommand,
      target.jumpHost
    ])
  }
}
