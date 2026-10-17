import { callRuntimeRpc, hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import {
  requireSessionOutcomeHost,
  type SessionOutcomeHostCapabilities
} from '../../../shared/session-outcome-routing'
import { outcomeRuntimeTarget, type SessionOutcomeOwner } from './session-outcome-owner'

export class OutcomeHostUnsupportedError extends Error {}
export function sessionOutcomeConnection(
  owner: SessionOutcomeOwner,
  expectedEnvironmentPairingRevision?: number
) {
  const target = outcomeRuntimeTarget(owner)
  const revision =
    target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(
          target.environmentId,
          expectedEnvironmentPairingRevision
        )
      : undefined
  const assertCurrent = () => {
    if (
      target.kind === 'environment' &&
      revision !== getRuntimeEnvironmentRevision(target.environmentId)
    ) {
      throw new Error(
        'The paired execution owner changed. Reopen its saved outcomes before continuing.'
      )
    }
  }
  const call = async <T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<T> => {
    assertCurrent()
    const result = await callRuntimeRpc<T>(target, method, params, {
      timeoutMs: options?.timeoutMs ?? 15_000,
      expectedEnvironmentPairingRevision: revision
    })
    assertCurrent()
    return result
  }
  const negotiate = async () => {
    let capabilities: SessionOutcomeHostCapabilities
    try {
      capabilities = await call<SessionOutcomeHostCapabilities>('sessionChain.outcomeCapabilities')
    } catch (error) {
      if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
        throw new OutcomeHostUnsupportedError(
          'This host predates durable outcomes. Update it to commit outcomes.'
        )
      }
      throw error
    }
    if (
      !capabilities ||
      typeof capabilities.version !== 'number' ||
      typeof capabilities.durableContinuation !== 'boolean'
    ) {
      throw new Error(
        'The outcome capability response is unverifiable. Restore this host before continuing.'
      )
    }
    let expectedExecutionRuntimeId: string | undefined
    try {
      expectedExecutionRuntimeId = requireSessionOutcomeHost(capabilities, target)
    } catch (error) {
      throw new OutcomeHostUnsupportedError(error instanceof Error ? error.message : String(error))
    }
    const ownedCall = <T>(
      method: string,
      params?: Record<string, unknown>,
      options?: { timeoutMs?: number }
    ): Promise<T> =>
      call<T>(method, params ? { ...params, expectedExecutionRuntimeId } : undefined, options)
    return { target, capabilities, call: ownedCall }
  }
  return { target, call, negotiate, assertCurrent }
}
