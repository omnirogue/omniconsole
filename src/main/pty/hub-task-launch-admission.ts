import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import type { PtyLaunchGateRequest } from '../../shared/pty-launch-gate'
import { consoleLaunchAuthorizesTask, hasConsoleLaunchAuthority } from './console-launch-authority'

function hubTaskEnvironment(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([name, value]) => {
    const key = process.platform === 'win32' ? name.toUpperCase() : name
    return key === 'OMNI_TASK_ID' && value?.trim() ? [value] : []
  })
}

export function assertUnboundHubTerminalLaunch(input: {
  hubTaskId?: string | null
  env?: Record<string, string>
  agentEnv?: Record<string, string>
  launchGate?: PtyLaunchGateRequest
  worktreeId?: string
}): void {
  const taskIds = [
    ...(input.hubTaskId?.trim() ? [input.hubTaskId.trim()] : []),
    ...hubTaskEnvironment(input.env),
    ...hubTaskEnvironment(input.agentEnv)
  ]
  if (
    (taskIds.length > 0 || hasConsoleLaunchAuthority(input.launchGate)) &&
    (taskIds.length === 0 ||
      !consoleLaunchAuthorizesTask(input.launchGate, taskIds, input.worktreeId))
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Hub-bound execution requires an admitted claim and canonical worker-prepare/worker-execute.'
    )
  }
}
