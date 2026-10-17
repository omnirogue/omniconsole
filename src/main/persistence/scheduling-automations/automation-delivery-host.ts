import type { Automation } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { projectAutomationSelector } from '../../../shared/automation-list-scope'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  automationProjectionContext,
  type AutomationStorageAuthority
} from './automation-owner-projection'

/** Local is relative to the store's execution process, including a paired runtime process. */
export function captureAutomationDeliveryHost(
  state: PersistedState,
  automation: Automation,
  authority: AutomationStorageAuthority = 'desktop'
): ExecutionHostId | null {
  const owner = projectAutomationSelector(
    automation,
    automationProjectionContext(state, authority, false)
  )
  return owner.kind === 'self'
    ? 'local'
    : owner.kind === 'ssh'
      ? toSshExecutionHostId(owner.targetId)
      : null
}
