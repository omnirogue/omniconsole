import {
  workflowPresetLabel,
  type WorkflowKind
} from '@/components/local-workflows/workflow-presets'
import type { MirroredWorkflowBucket } from '@/store/slices/mirrored-workflow-records'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SessionWorkflowAnchorStatus } from '../../../shared/session-workflow-anchor'
import type { LocalWorkflowTabStatus, SidebarWorkflow } from './local-workflow-tab-status'
import type { sidebarSessionWorkspace } from './sidebar-session-context'
import type { SidebarSession } from './sidebar-sessions'

/** A paired controller's workflow conversation, as its mirrored row carries it (step 9). */
export type MirroredSidebarWorkflow = {
  environmentId: string
  /** The anchor tab on the controller: what activation names there. */
  hostTabId: string
  /** Step 8's run address on the controller; null before the run exists. */
  runId: string | null
  /** The controller's own archive mark (the record's archive reference). */
  archivedByOwner: boolean
}

const KNOWN_WORKFLOW_KINDS: ReadonlySet<string> = new Set<WorkflowKind>([
  'audit',
  'custom',
  'best-of-n',
  'improve',
  'find',
  'decide',
  'investigate',
  'quick-discover',
  'build-review',
  'evolve',
  'council',
  'discover'
])

/**
 * The mirrored row's durable identity: its controller, workspace and anchor tab. Archive marks,
 * folders and hides key on it; a status or run change never moves it.
 */
export function mirroredWorkflowRowKey(
  hostId: ExecutionHostId,
  worktreeId: string,
  hostTabId: string
): string {
  return JSON.stringify([hostId, 'workflow', worktreeId, hostTabId])
}

/** As the controller's own row shows it: a Start in flight is already running work. */
function displayStatus(status: SessionWorkflowAnchorStatus): LocalWorkflowTabStatus {
  return status === 'starting' ? 'running' : status
}

/** Rows for every mirrored workflow conversation, counted under the controller's host. */
export function mirroredWorkflowRows(
  buckets: Readonly<Record<string, MirroredWorkflowBucket>> | undefined,
  workspaceContext: (
    worktreeId: string,
    hostId?: ExecutionHostId
  ) => ReturnType<typeof sidebarSessionWorkspace>
): SidebarSession[] {
  const rows: SidebarSession[] = []
  for (const bucket of Object.values(buckets ?? {})) {
    const hostId = toRuntimeExecutionHostId(bucket.environmentId)
    const context = workspaceContext(bucket.worktreeId, hostId)
    for (const record of bucket.records) {
      // Why: a newer controller's kind this build cannot name is shown as a generic workflow.
      const preset = (
        KNOWN_WORKFLOW_KINDS.has(record.preset) ? record.preset : 'custom'
      ) as WorkflowKind
      // Why: rows of a controller that stopped sending sets are kept but read "status unavailable".
      const status = bucket.unverified ? 'unavailable' : displayStatus(record.status)
      const workflow: SidebarWorkflow = {
        preset,
        status,
        ...(record.phase ? { phase: record.phase } : {}),
        ...(record.origin ? { origin: record.origin } : {}),
        ...(record.host ? { host: record.host } : {}),
        ...(record.runId ? { runId: record.runId } : {})
      }
      const key = mirroredWorkflowRowKey(hostId, bucket.worktreeId, record.tabId)
      rows.push({
        ...context,
        ...(status === 'draft' ? { launchPending: true } : {}),
        rowKey: key,
        sessionKey: key,
        worktreeId: bucket.worktreeId,
        // Why no tab or pane: nothing of it lives in this window; it opens on its controller.
        tabId: null,
        paneKey: null,
        kind: 'terminal',
        label: record.title || workflowPresetLabel(preset),
        agent: workflowPresetLabel(preset),
        workflow,
        folderKeyMigration: null,
        mirroredWorkflow: {
          environmentId: bucket.environmentId,
          hostTabId: record.tabId,
          runId: record.runId,
          archivedByOwner: record.archived === true
        }
      })
    }
  }
  return rows
}

/** Keys of mirrored rows their controller archived, merged into the list's archive marks. */
export function mirroredWorkflowOwnerArchivedKeys(
  buckets: Readonly<Record<string, MirroredWorkflowBucket>> | undefined
): string[] {
  const keys: string[] = []
  for (const bucket of Object.values(buckets ?? {})) {
    const hostId = toRuntimeExecutionHostId(bucket.environmentId)
    for (const record of bucket.records) {
      if (record.archived) {
        keys.push(mirroredWorkflowRowKey(hostId, bucket.worktreeId, record.tabId))
      }
    }
  }
  return keys
}
