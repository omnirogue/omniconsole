import { useEffect } from 'react'
import { getSystemPrefersDarkSnapshot } from '../components/terminal-pane/use-system-prefers-dark'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual,
  scheduleRuntimeGraphSync,
  setRuntimeGraphSessionArchivePublicationGetter,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from '../runtime/sync-runtime-graph'
import { sessionArchivePublication } from '../runtime/session-archive-publication'
import { useAppStore } from '../store'
import { useSessionSidebarView } from '../store/session-sidebar-view'
import { useSessionWorkflowRecordPublication } from '../runtime/session-workflow-record-publication'
import { useSessionConversationLedgerPublication } from '../runtime/session-conversation-ledger-publication'

/** Keeps the mobile runtime graph republished as the store's session-visible state changes. */
export function useRuntimeGraphSync(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  // Why: workflow anchors have no pane, so they publish beside the graph (session counts, step 9).
  useSessionWorkflowRecordPublication()
  // Why: dormant and slept conversations and the owner's marks never ride the graph (session parity).
  useSessionConversationLedgerPublication()

  useEffect(() => {
    setRuntimeGraphSessionArchivePublicationGetter(sessionArchivePublication)
    setRuntimeGraphStoreStateGetter(useAppStore.getState)
    return () => {
      setRuntimeGraphStoreStateGetter(null)
      setRuntimeGraphSessionArchivePublicationGetter(null)
    }
  }, [])

  useEffect(() => {
    let previousKey = getRuntimeMobileSessionSyncKey(useAppStore.getState())
    return useAppStore.subscribe((state, previousState) => {
      // Why: this fires on every store mutation; read the cached prefers-dark snapshot instead of allocating a throwaway MediaQueryList via matchMedia each tick.
      const systemPrefersDark = getSystemPrefersDarkSnapshot()
      // Why: skip the key build when every input is reference-unchanged; the gate mirrors every field getRuntimeMobileSessionSyncKey uses.
      if (
        canSkipRuntimeMobileSessionSyncKeyBuild(
          state,
          previousState,
          systemPrefersDark,
          previousKey.systemPrefersDark
        )
      ) {
        return
      }
      const nextKey = getRuntimeMobileSessionSyncKey(
        state,
        previousState,
        previousKey,
        systemPrefersDark
      )
      if (runtimeMobileSessionSyncKeysEqual(nextKey, previousKey)) {
        return
      }
      previousKey = nextKey
      scheduleRuntimeGraphSync()
    })
  }, [])

  useEffect(() => {
    setRuntimeGraphSyncEnabled(workspaceSessionReady)
    return () => {
      setRuntimeGraphSyncEnabled(false)
    }
  }, [workspaceSessionReady])

  useEffect(
    () =>
      useSessionSidebarView.subscribe((state, previous) => {
        if (
          state.loaded !== previous.loaded ||
          state.archiveStorageReady !== previous.archiveStorageReady ||
          state.archived !== previous.archived ||
          state.view.archived !== previous.view.archived
        ) {
          scheduleRuntimeGraphSync()
        }
      }),
    []
  )
}
