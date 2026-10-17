import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  browserTabsVetoGuestEviction,
  worktreeHoldsLiveBrowserGuests
} from '@/components/browser-pane/host-guest/browser-guest-worktree-retention'
import {
  hasLiveBrowserGuest,
  webviewRegistry
} from '@/components/browser-pane/host-guest/webview-registry'
import { destroyWorktreeBrowserGuests } from '@/store/slices/browser-webview-cleanup'
import type { IdleKeepReading } from '../../../../shared/idle-auto-close-settings'
import type { ProcessInspection } from './idle-auto-close-decision'
import { readKeptSessions, type IdleKeptSessions } from './idle-auto-close-keep'
import { readKeepReadingsFromMain } from './idle-keep-guards'

/** Unknown means keep: a guest that cannot answer counts as audible. */
function isBrowserGuestAudible(browserPageId: string): boolean {
  const guest = webviewRegistry.get(browserPageId)
  if (!guest) {
    return false
  }
  try {
    return guest.isCurrentlyAudible()
  } catch {
    return true
  }
}

/** Everything the R2/R3 coordinator reads or does outside the store, injectable for tests. */
export type IdleAutoCloseDeps = {
  listSessions: () => Promise<PtyListedSession[]>
  /** The local runtime's terminals; null when they could not be read. */
  listLocalTerminals: () => Promise<RuntimeTerminalSummary[] | null>
  inspectProcess: (ptyId: string) => Promise<ProcessInspection>
  /**
   * Stops every shell of the workspace keeping its history (the store's Sleep, terminals only);
   * tabs and layouts stay, and opening the workspace restores each shell with its output.
   */
  sleepShellWorkspace: (worktreeId: string) => Promise<void>
  holdsLiveGuests: (state: AppState, worktreeId: string) => boolean
  isGuestEvictable: (state: AppState, worktreeId: string) => boolean
  /** Any live page of the workspace is audible now (R3 keeps it). */
  isGuestPlayingAudio: (state: AppState, worktreeId: string) => boolean
  discardWorktreeGuests: (state: AppState, worktreeId: string) => void
  readKeptSessions: (state: AppState) => Promise<IdleKeptSessions | null>
  /** main's G1 reading (Stage A1 state, asking replies) for the panes an act is about to touch. */
  readKeep: (targets: { worktreeId: string; paneKey: string }[]) => Promise<IdleKeepReading[]>
  notifySleptShellWorkspaces: (worktreeIds: readonly string[]) => void
}

/** One notice per tick for the workspaces R2 put to sleep. */
function showSleptShellWorkspacesNotice(worktreeIds: readonly string[]): void {
  if (worktreeIds.length === 0) {
    return
  }
  toast.success(
    worktreeIds.length === 1
      ? translate('idleAutoClose.sleptShellsOne', 'Put 1 idle shell workspace to sleep')
      : translate('idleAutoClose.sleptShells', 'Put {{count}} idle shell workspaces to sleep', {
          count: worktreeIds.length
        }),
    {
      id: 'idle-auto-close-shells',
      description: translate(
        'idleAutoClose.sleptShellsDescription',
        'Nothing ran in their shells for the idle window. Opening a workspace restarts its shells with their output.'
      )
    }
  )
}

export function createDefaultIdleAutoCloseDeps(): IdleAutoCloseDeps {
  return {
    listSessions: () => window.api.pty.listSessions(),
    listLocalTerminals: async () => {
      try {
        const result = await callRuntimeRpc<RuntimeTerminalListResult>(
          { kind: 'local' },
          'terminal.list',
          { limit: 10_000, includeVisualLayouts: false },
          { timeoutMs: 10_000 }
        )
        return result.truncated ? null : result.terminals
      } catch {
        return null
      }
    },
    inspectProcess: (ptyId) => window.api.pty.inspectProcess(ptyId),
    // Why the store's Sleep (terminals only, never browsers): it keeps every shell's history (G6)
    // and has a wake, since activating a workspace whose tabs are all dead remounts each pane,
    // which cold-restores its history into a fresh shell at the same cwd. Why no pane keys: the
    // workspace holds no agent state, and an empty list captures and removes no sleeping record.
    sleepShellWorkspace: (worktreeId) =>
      useAppStore
        .getState()
        .shutdownWorktreeTerminals(worktreeId, { keepIdentifiers: true, sleepingPaneKeys: [] }),
    holdsLiveGuests: (state, worktreeId) =>
      worktreeHoldsLiveBrowserGuests(
        state.browserTabsByWorktree[worktreeId] ?? [],
        state.browserPagesByWorkspace,
        hasLiveBrowserGuest
      ),
    isGuestEvictable: (state, worktreeId) =>
      !browserTabsVetoGuestEviction(state.browserTabsByWorktree[worktreeId] ?? []),
    isGuestPlayingAudio: (state, worktreeId) =>
      worktreeHoldsLiveBrowserGuests(
        state.browserTabsByWorktree[worktreeId] ?? [],
        state.browserPagesByWorkspace,
        isBrowserGuestAudible
      ),
    // Why the budget's path: URL, title and zoom stay in the store and a revisit rebuilds the page.
    // The budget (Terminal.tsx) evicts only hidden worktrees whose surface is still mounted
    // (`isRetained`), so this is the same discard on the same kind of target, not a new one.
    discardWorktreeGuests: (state, worktreeId) =>
      destroyWorktreeBrowserGuests(
        state.browserTabsByWorktree,
        state.browserPagesByWorkspace,
        worktreeId
      ),
    readKeptSessions,
    readKeep: readKeepReadingsFromMain,
    notifySleptShellWorkspaces: showSleptShellWorkspacesNotice
  }
}
