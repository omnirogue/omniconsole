import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { SESSION_WORKFLOW_OPEN_RPC } from '../../../shared/session-workflow-records'
import type { SidebarSession } from './sidebar-sessions'

const OPEN_TIMEOUT_MS = 15_000

/**
 * Opens a paired controller's workflow conversation visibly on that computer (session counts,
 * step 9). Nothing is created here: no tab, no terminal and no run. The controller refuses one its
 * own window no longer publishes; a refusal leaves the row to the next publication.
 */
export async function activateMirroredWorkflow(row: SidebarSession): Promise<boolean> {
  const mirrored = row.mirroredWorkflow
  if (!mirrored || row.unavailable) {
    return false
  }
  try {
    if (
      !(await runtimeEnvironmentSupportsCapability(
        mirrored.environmentId,
        SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY,
        OPEN_TIMEOUT_MS
      ))
    ) {
      return false
    }
    await callRuntimeRpc(
      { kind: 'environment', environmentId: mirrored.environmentId },
      SESSION_WORKFLOW_OPEN_RPC,
      { worktree: row.worktreeId, tabId: mirrored.hostTabId },
      { timeoutMs: OPEN_TIMEOUT_MS }
    )
  } catch (error) {
    console.warn('[mirrored-workflow] the controller did not open it:', error)
    return false
  }
  const host = useAppStore
    .getState()
    .runtimeEnvironments?.find((environment) => environment.id === mirrored.environmentId)?.name
  toast.success(
    host
      ? translate('conversations.mirroredWorkflowOpenedOn', 'Opened on {{host}}.', { host })
      : translate('conversations.mirroredWorkflowOpened', 'Opened on the computer that runs it.')
  )
  return true
}
