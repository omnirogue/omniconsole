// This window's own workflow conversations, published to its main process so paired clients can
// count and open them (session counts, step 9). Workflow anchors have no pane, so the terminal-leaf
// publication never carried them. A workflow is the run of the window that holds its anchor tab
// (step 8 routes its run to this controller), so every anchor in this window's tabs is published,
// also one in a workspace a paired computer owns: it is this computer's run. Peer rows never sit
// here: a mirror never carries `localWorkflow`, and mirrored workflow records live in their own
// receiver slice, so a peer's record is never republished.

import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { workflowSidebarRowFields } from '@/lib/local-workflow-tab-status'
import { sessionManageWorkflowAnchor } from '@/lib/session-manage-workflow-anchor'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import type {
  RuntimeSessionWorkflowRecord,
  SessionWorkflowRecordWindowPublication
} from '../../../shared/session-workflow-records'
import { isValidHostTerminalTabId } from '../../../shared/terminal-tab-id'
import { getRuntimeGraphRendererGeneration, onRuntimeGraphSynced } from './sync-runtime-graph'

const PUBLISH_COALESCE_MS = 100
const RETRY_INITIAL_MS = 500
const RETRY_MAX_MS = 30_000

/** The store slices a publication reads; a change to any of them may change what is published. */
const PUBLICATION_INPUTS = [
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'localWorkflowStatusByTabId',
  'localWorkflowHydrationByTabId',
  'buildReview',
  // Why: the archive key names the row's host, which these resolve.
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironments',
  'activeWorkspaceExecutionHostId',
  'hydrationSucceeded'
] as const satisfies readonly (keyof AppState)[]

/**
 * Every workflow anchor this window holds, by workspace, with step 8's outcome and this
 * computer's archive mark (keyed exactly as its own sidebar keys the row). The same population as
 * this computer's own sidebar workflow rows.
 */
export function buildSessionWorkflowRecords(
  state: AppState,
  archivedKeys: ReadonlySet<string>
): Record<string, RuntimeSessionWorkflowRecord[]> {
  const byWorktree: Record<string, RuntimeSessionWorkflowRecord[]> = {}
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    const records: RuntimeSessionWorkflowRecord[] = []
    for (const tab of tabs) {
      // Why host ids only: a web-terminal mirror id names a peer's tab, never this window's run.
      if (!tab.localWorkflow || !isValidHostTerminalTabId(tab.id)) {
        continue
      }
      const unified = state.unifiedTabsByWorktree?.[worktreeId]?.find(
        (item) => item.entityId === tab.id && item.contentType === 'terminal'
      )
      const { workflow } = workflowSidebarRowFields(tab, state)
      const anchor = sessionManageWorkflowAnchor({ workflow })
      if (!workflow || !anchor) {
        continue
      }
      const { hostId } = sidebarSessionWorkspace(state, worktreeId, unified?.executionHostId)
      records.push({
        tabId: tab.id,
        preset: workflow.preset,
        title: tab.customTitle || tab.title,
        status: anchor.status,
        runId: anchor.runId,
        ...(workflow.phase ? { phase: workflow.phase } : {}),
        ...(workflow.host ? { host: workflow.host } : {}),
        ...(workflow.origin ? { origin: workflow.origin } : {}),
        // Why this key: the owner's own row key for a workflow conversation (sidebar-sessions).
        ...(archivedKeys.has(JSON.stringify([hostId, worktreeId, tab.id]))
          ? { archived: true as const }
          : {})
      })
    }
    if (records.length > 0) {
      byWorktree[worktreeId] = records
    }
  }
  return byWorktree
}

function currentArchivedKeys(): ReadonlySet<string> {
  const { archived, view } = useSessionSidebarView.getState()
  return new Set([...(archived ?? []), ...(view?.archived ?? [])])
}

/**
 * Publishes the set whenever it changes. Main accepts only the renderer generation whose graph it
 * holds, so a refused send (graph not synced yet, a reload, a window not yet authoritative) is
 * retried with bounded backoff until it lands or the set changes again. Returns the stop.
 */
export function startSessionWorkflowRecordPublication(
  send: (publication: SessionWorkflowRecordWindowPublication) => Promise<void>
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let published: string | null = null
  let retryDelay = RETRY_INITIAL_MS
  let refused = false
  let stopped = false
  const publish = (): void => {
    timer = null
    const recordsByWorktree = buildSessionWorkflowRecords(
      useAppStore.getState(),
      currentArchivedKeys()
    )
    // Why: a degraded startup restored no sessions, so its empty set is unknown, not "none".
    const complete = useAppStore.getState().hydrationSucceeded !== false
    const signature = JSON.stringify([complete, recordsByWorktree])
    if (stopped || signature === published) {
      return
    }
    published = signature
    void send({
      rendererGeneration: getRuntimeGraphRendererGeneration(),
      recordsByWorktree,
      complete
    })
      .then(() => {
        retryDelay = RETRY_INITIAL_MS
      })
      .catch(() => {
        if (stopped || published !== signature) {
          return
        }
        published = null
        refused = true
        if (timer === null) {
          timer = setTimeout(publish, retryDelay)
        }
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
      })
  }
  // Why: main refuses until it holds this renderer's graph; once that sync lands, retry at once.
  const retryOnGraphSync = (): void => {
    if (refused && !stopped) {
      refused = false
      if (timer !== null) {
        clearTimeout(timer)
      }
      publish()
    }
  }
  const stopGraphSync = onRuntimeGraphSynced(retryOnGraphSync)
  const schedule = (): void => {
    if (!stopped && timer === null) {
      timer = setTimeout(publish, PUBLISH_COALESCE_MS)
    }
  }
  const stopApp = useAppStore.subscribe((state, previous) => {
    if (PUBLICATION_INPUTS.some((input) => state[input] !== previous[input])) {
      schedule()
    }
  })
  const stopView = useSessionSidebarView.subscribe((state, previous) => {
    if (state.archived !== previous.archived || state.view !== previous.view) {
      schedule()
    }
  })
  publish()
  return () => {
    stopped = true
    stopGraphSync()
    stopApp()
    stopView()
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/** Publishes only once this window has restored its sessions: before that, empty means nothing. */
export function useSessionWorkflowRecordPublication(): void {
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  useEffect(() => {
    const send = window.api?.runtime?.syncSessionWorkflowRecords
    return workspaceSessionReady && typeof send === 'function'
      ? startSessionWorkflowRecordPublication(send)
      : undefined
  }, [workspaceSessionReady])
}
