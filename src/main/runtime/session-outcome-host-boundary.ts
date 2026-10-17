import type { SessionChain } from '../../shared/session-chain-types'
import { SESSION_OUTCOME_RELAY_REFUSAL } from '../../shared/session-outcome-routing'
import type { OrcaRuntimeService } from './omni-runtime'
import type { RpcContext } from './rpc/core'

export function assertSessionOutcomeRuntime(
  context: RpcContext,
  expectedExecutionRuntimeId?: string
): void {
  if (context.pairedDeviceId && !expectedExecutionRuntimeId) {
    throw new Error(
      'Negotiate outcome ownership with this paired execution host before invoking it.'
    )
  }
  if (expectedExecutionRuntimeId && expectedExecutionRuntimeId !== context.runtime.getRuntimeId()) {
    throw new Error(
      'The execution runtime changed. Reconnect and inspect the durable outcome set before retrying; no local fallback is permitted.'
    )
  }
}

export async function sessionOutcomeLocalWorkspace(
  runtime: OrcaRuntimeService,
  worktreeId: string
) {
  const scope = await runtime.getSessionOutcomeExecutionScope(worktreeId)
  if (scope.connectionId) {
    throw new Error(SESSION_OUTCOME_RELAY_REFUSAL)
  }
  if (scope.wslDistro) {
    throw new Error(
      'Connect to the paired headless runtime inside this WSL distribution. Windows-local outcome verification cannot own WSL execution.'
    )
  }
  return scope
}

export async function assertSessionOutcomeExecutionScope(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): Promise<void> {
  if (chain.placement && chain.placement !== 'local') {
    throw new Error(SESSION_OUTCOME_RELAY_REFUSAL)
  }
  const scope = await sessionOutcomeLocalWorkspace(runtime, chain.worktreeId)
  if (scope.path !== chain.workspacePath) {
    throw new Error('The outcome workspace does not match the execution host workspace.')
  }
  if (chain.sourceWorktreeId && chain.sourceWorktreeId !== chain.worktreeId) {
    const source = await runtime.getSessionOutcomeExecutionScope(chain.sourceWorktreeId)
    if (source.connectionId || source.wslDistro) {
      throw new Error('The source and outcome must be owned by this same execution runtime.')
    }
  }
}
