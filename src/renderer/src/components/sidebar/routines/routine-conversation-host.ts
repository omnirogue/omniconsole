import { useAppStore } from '@/store'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { Automation } from '../../../../../shared/automations-types'
import type { AutomationHostTarget } from '@/components/automations/automation-host-client'

export function routineConversationHost(
  automation: Automation,
  target: AutomationHostTarget
): ExecutionHostId {
  if (target.kind === 'environment') {
    return toRuntimeExecutionHostId(target.environmentId)
  }
  return (
    getResolvedExecutionHostIdForWorktree(useAppStore.getState(), automation.workspaceId) ??
    (automation.executionTargetType === 'ssh'
      ? toSshExecutionHostId(automation.executionTargetId)
      : (parseExecutionHostId(automation.runContext?.hostId)?.id ?? 'local'))
  )
}
