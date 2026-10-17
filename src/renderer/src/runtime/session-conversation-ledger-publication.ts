// This window's own conversation ledger (session parity, step 2), published to its own main
// process, which carries it to paired computers beside each workspace snapshot: every conversation
// this computer's sidebar lists under `local` — live, dormant and slept tabs and tab-less records —
// with its rest, archive, folder, saved and hidden marks and a sanitized title, plus the passive
// evidence it holds apart (session-conversation-ledger-eligibility.ts decides who is listed;
// session-conversation-ledger-records.ts writes each record). Modelled on
// session-workflow-record-publication.ts: coalesced, retried while main refuses this renderer
// generation, rebuilt only when one of its inputs changes, and never published before the person's
// folder, archive and deletion marks have loaded — this publisher never loads them itself.

import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { SessionSidebarViewState } from '@/store/session-sidebar-view-state'
import { getShownChains, subscribeSessionChains } from '@/lib/session-chain-registry'
import { selectSidebarSessionStatus } from '@/lib/sidebar-session-status-projection'
import type { SessionConversationLedgerWindowPublication } from '../../../shared/session-conversation-ledger'
import { startLivePtyCensus, type LivePtyCensusApi } from './live-pty-census'
import { rememberPublishedConversationLedger } from './session-conversation-ledger-latest'
import { buildSessionConversationLedger } from './session-conversation-ledger-records'
import { getRuntimeGraphRendererGeneration, onRuntimeGraphSynced } from './sync-runtime-graph'

export { buildSessionConversationLedger } from './session-conversation-ledger-records'
export {
  selectConversationLedgerEligibility,
  type ConversationLedgerEligibility,
  type ConversationLedgerQuarantineReason
} from './session-conversation-ledger-eligibility'

const PUBLISH_COALESCE_MS = 100
const RETRY_INITIAL_MS = 500
const RETRY_MAX_MS = 30_000

/**
 * The app-store slices a publication reads (agent status is compared through its row-shaping
 * projection); a change to any other slice publishes nothing.
 */
const PUBLICATION_INPUTS = [
  // The rows the sidebar builds (use-sidebar-sessions.ts).
  'repos',
  'worktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'sshConnectionStates',
  'runtimeStatusByEnvironmentId',
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'terminalLayoutsByTabId',
  'sleepingAgentSessionsByPaneKey',
  'pendingStartupByTabId',
  'automaticAgentResumeClaimsByTabId',
  'localWorkflowStatusByTabId',
  'localWorkflowHydrationByTabId',
  'buildReview',
  'mirroredWorkflowRecordsByOwner',
  // Ownership: workspace provenance and each tab's own PTY bindings.
  'detectedWorktreesByRepo',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'ptyIdsByTabId',
  // Coverage: complete only once this window restored its sessions.
  'hydrationSucceeded',
  'terminalStartupRestorationReady'
] as const satisfies readonly (keyof AppState)[]

function viewInputsChanged(state: SessionSidebarViewState, previous: SessionSidebarViewState) {
  return (
    state.loaded !== previous.loaded ||
    state.archiveStorageReady !== previous.archiveStorageReady ||
    state.archived !== previous.archived ||
    state.view.archived !== previous.view.archived ||
    state.view.autoArchiveLog !== previous.view.autoArchiveLog ||
    state.view.deleted !== previous.view.deleted ||
    state.view.hidden !== previous.view.hidden
  )
}

/** Main assigns ordering; the listing time and renderer generation alone are no change. */
function signatureOf(publication: SessionConversationLedgerWindowPublication): string {
  const { rendererGeneration: _generation, listedAt: _listedAt, ...set } = publication
  return JSON.stringify(set)
}

/**
 * Publishes the ledger whenever it changes. Main accepts only the renderer generation whose graph
 * it holds, so a refused send is retried with bounded backoff, and at once when that graph lands.
 * `pty` is main's PTY census source (F16); without it every bound pane's rest is unknown.
 */
export function startSessionConversationLedgerPublication(
  send: (publication: SessionConversationLedgerWindowPublication) => Promise<void>,
  options: { pty?: LivePtyCensusApi } = {}
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let published: string | null = null
  let retryDelay = RETRY_INITIAL_MS
  let refused = false
  let stopped = false
  const schedule = (): void => {
    if (!stopped && timer === null) {
      timer = setTimeout(publish, PUBLISH_COALESCE_MS)
    }
  }
  const census = startLivePtyCensus(options.pty, schedule)
  function publish(): void {
    timer = null
    const folders = useSessionFolders.getState()
    const view = useSessionSidebarView.getState()
    // Why: before the person's marks load, a missing archive or deletion mark proves nothing.
    if (stopped || !folders.loaded || !view.loaded || !view.archiveStorageReady) {
      return
    }
    const publication = buildSessionConversationLedger(useAppStore.getState(), {
      view,
      metadata: folders.metadata,
      livePtyIds: census.current(),
      chains: getShownChains(),
      rendererGeneration: getRuntimeGraphRendererGeneration(),
      listedAt: Date.now()
    })
    // Why: the owner's own counts report rest as its peers receive it (session parity, step 8).
    rememberPublishedConversationLedger(publication)
    const signature = signatureOf(publication)
    if (signature === published) {
      return
    }
    published = signature
    void send(publication)
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
  const stopGraphSync = onRuntimeGraphSynced(() => {
    if (refused && !stopped) {
      refused = false
      if (timer !== null) {
        clearTimeout(timer)
      }
      publish()
    }
  })
  let status = selectSidebarSessionStatus(useAppStore.getState().agentStatusByPaneKey ?? {})
  const stopApp = useAppStore.subscribe((state, previous) => {
    let changed = PUBLICATION_INPUTS.some((input) => state[input] !== previous[input])
    if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
      // Why: a status ping republishes this map many times a minute and moves no row.
      const next = selectSidebarSessionStatus(state.agentStatusByPaneKey ?? {})
      changed ||= next !== status
      status = next
    }
    if (changed) {
      schedule()
    }
  })
  const stopView = useSessionSidebarView.subscribe((state, previous) => {
    if (viewInputsChanged(state, previous)) {
      schedule()
    }
  })
  const stopFolders = useSessionFolders.subscribe((state, previous) => {
    if (state.loaded !== previous.loaded || state.metadata !== previous.metadata) {
      schedule()
    }
  })
  const stopChains = subscribeSessionChains(schedule)
  publish()
  return () => {
    stopped = true
    census.stop()
    stopGraphSync()
    stopApp()
    stopView()
    stopFolders()
    stopChains()
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/** Publishes only once this window has restored its sessions: before that, empty means nothing. */
export function useSessionConversationLedgerPublication(): void {
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)
  useEffect(() => {
    const send = window.api?.runtime?.syncSessionConversationLedger
    return workspaceSessionReady && typeof send === 'function'
      ? startSessionConversationLedgerPublication(send, { pty: window.api?.pty })
      : undefined
  }, [workspaceSessionReady])
}
