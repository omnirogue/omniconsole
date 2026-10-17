import { readAutomaticCleanupProtection } from './automatic-session-cleanup-protection'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { ArchiveSleepHostReading } from '../../../shared/archive-sleep-contract'
import { SESSION_ORGANIZATION_RPC } from '../../../shared/session-organization-change'
import type { ArchiveSleepDeps } from './archive-sleep-evaluate'
import { installArchiveSleepController } from './archive-sleeps-idle-agents'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from './foreground-terminal-tabs'
import { getDriverForPty, getDriverReleasedAtForPty } from './pane-manager/mobile-driver-state'
import { putSidebarSessionToSleep } from './put-session-to-sleep'
import { buildPaneSessions } from './sidebar-sessions'
import { mergePendingTerminalInputActivity } from './terminal-input-activity-coalescing'
import { isTerminalTabRendererVisible } from './terminal-pane-visibility-registry'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'

const HOST_READING_TIMEOUT_MS = 15_000

/** The window's own readings and actions behind the archive-sleep controller. */
export function windowArchiveSleepDeps(): ArchiveSleepDeps {
  return {
    readProtection: readAutomaticCleanupProtection,
    app: () => useAppStore.getState(),
    view: () => useSessionSidebarView.getState(),
    panes: (state) => buildPaneSessions(state),
    host: (state, worktreeId) => ({
      executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
      runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    }),
    now: () => Date.now(),
    touch: (state, now) => ({
      now,
      foregroundTabIds: getForegroundTerminalTabIds(),
      lastSeenAtByTabId: getForegroundTerminalTabLastSeenAtById(),
      // Why merged: input stamps are coalesced; a keystroke not flushed yet still counts.
      inputAtByPaneKey: mergePendingTerminalInputActivity(state.lastTerminalInputAtByPaneKey ?? {}),
      isTabVisible: isTerminalTabRendererVisible,
      isPtyDriven: (ptyId) => getDriverForPty(ptyId).kind !== 'idle',
      ptyDriverReleasedAt: getDriverReleasedAtForPty
    }),
    readHost: (session) =>
      session.paneKey && session.tabId
        ? callRuntimeRpc<ArchiveSleepHostReading>(
            { kind: 'local' },
            SESSION_ORGANIZATION_RPC.archiveSleepReading,
            { paneKey: session.paneKey, tabId: session.tabId, worktreeId: session.worktreeId },
            { timeoutMs: HOST_READING_TIMEOUT_MS }
          )
        : Promise.resolve({ clear: false, keep: 'unreadable' }),
    sleep: (session) => putSidebarSessionToSleep(session),
    audit: async (note) => {
      const answer = await callRuntimeRpc<{ auditError?: string } | undefined>(
        { kind: 'local' },
        SESSION_ORGANIZATION_RPC.noteArchiveSleep,
        note
      )
      if (answer?.auditError) {
        throw new Error(answer.auditError)
      }
    },
    subscribeApp: (listener) => useAppStore.subscribe(listener),
    setTimer: (run, ms) => {
      const handle = setTimeout(run, ms)
      return () => clearTimeout(handle)
    }
  }
}

/** Installed once by the window; returns the uninstall. */
export function installArchiveSleepsIdleAgents(): () => void {
  return installArchiveSleepController(windowArchiveSleepDeps())
}
