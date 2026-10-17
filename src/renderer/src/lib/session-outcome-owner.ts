import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  SESSION_OUTCOME_RELAY_REFUSAL,
  type SessionOutcomeRuntimeTarget
} from '../../../shared/session-outcome-routing'
import { useAppStore } from '@/store'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'

export type SessionOutcomeOwner =
  | { hostId?: string | null; placement?: string; worktreeId?: string }
  | SessionOutcomeRuntimeTarget

export function outcomeRuntimeTarget(owner: SessionOutcomeOwner): SessionOutcomeRuntimeTarget {
  if ('kind' in owner && owner.kind === 'local') {
    return { kind: 'local' }
  }
  if ('kind' in owner && owner.kind === 'environment') {
    if (!owner.environmentId?.trim()) {
      throw new Error('The outcome environment owner is missing. Select its execution host again.')
    }
    return { kind: 'environment', environmentId: owner.environmentId }
  }
  const placement = parseExecutionHostId(owner.placement ?? owner.hostId)
  if (placement?.kind === 'ssh') {
    throw new Error(SESSION_OUTCOME_RELAY_REFUSAL)
  }
  if (placement?.kind === 'runtime') {
    return { kind: 'environment', environmentId: placement.environmentId }
  }
  if (placement?.kind === 'local') {
    return { kind: 'local' }
  }
  if (owner.worktreeId) {
    const result = resolveWorktreeOperationRouteResult(useAppStore.getState(), owner.worktreeId)
    if (result.kind === 'resolved') {
      return result.route.runtimeEnvironmentId
        ? { kind: 'environment', environmentId: result.route.runtimeEnvironmentId }
        : outcomeRuntimeTarget({ hostId: result.route.executionHostId })
    }
    throw new Error(
      'The outcome workspace owner is missing or ambiguous. Restore its explicit host before continuing.'
    )
  }
  throw new Error(
    'The outcome execution owner is unknown. Restore the session owner before continuing.'
  )
}

export function outcomeOwnerKey(owner: SessionOutcomeOwner): string {
  const target = outcomeRuntimeTarget(owner)
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}
