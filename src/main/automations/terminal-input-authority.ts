import type { Store } from '../persistence'
import type { AutomationOutputBindingRequest } from '../../shared/automations-types'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { resolveInheritedHubBinding } from '../runtime/orchestration/db/hub/inherited-hub-binding'
import { assertAutomationHubAuthority } from '../../shared/automation-hub-authority'
import { getAutomationWorkspaceHubRefusal } from './hub-workspace-authority'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

export type AutomationTerminalInput = {
  workspaceId: string
  paneKey: string
  ptyId: string
  text: string
  automationOutputBinding?: AutomationOutputBindingRequest
}

export function assertAutomationTerminalInputAuthority(input: {
  request: AutomationTerminalInput
  handle: string
  currentHandle: string | null
  writePtyId: string
  authority: OrchestrationCompatibilityTerminalAuthority | null
  store: Pick<Store, 'getWorktreeMeta'> &
    Partial<Pick<Store, 'getFolderWorkspaces' | 'getWorktreeMetaForHost'>>
  processIncarnation: string | null
  db: OrchestrationDb
  launchHubTaskId?: string
}): void {
  const { request, authority } = input
  if (
    input.currentHandle !== input.handle ||
    input.writePtyId !== request.ptyId ||
    !authority ||
    authority.terminalHandle !== input.handle ||
    authority.ptyId !== request.ptyId ||
    authority.worktreeId !== request.workspaceId ||
    authority.paneKey !== request.paneKey ||
    authority.processIncarnation !== input.processIncarnation
  ) {
    throw new Error('automation_terminal_authority_changed')
  }
  if (authority.hostScope.kind !== 'local') {
    throw new Error(
      'Automation input must be admitted by its execution host; remote reuse is unavailable.'
    )
  }
  if (!input.store.getFolderWorkspaces) {
    throw new Error('Automation workspace authority is unavailable.')
  }
  const refusal = getAutomationWorkspaceHubRefusal(
    {
      getWorktreeMeta: input.store.getWorktreeMeta.bind(input.store),
      getFolderWorkspaces: input.store.getFolderWorkspaces.bind(input.store),
      ...(input.store.getWorktreeMetaForHost
        ? { getWorktreeMetaForHost: input.store.getWorktreeMetaForHost.bind(input.store) }
        : {})
    },
    authority.worktreeId,
    LOCAL_EXECUTION_HOST_ID
  )
  if (refusal) {
    throw new Error(refusal)
  }
  assertAutomationHubAuthority(input.launchHubTaskId)
  const binding = resolveInheritedHubBinding(input.db, {
    coordinatorHandle: input.handle,
    coordinatorPaneKey: request.paneKey,
    coordinatorProcessIncarnation: authority.processIncarnation ?? undefined
  })
  assertAutomationHubAuthority(binding.hubTaskId)
}
