import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { revealTerminalTabForPerson } from '@/components/terminal-pane/pty-connection/cold-restore-reveal-hold'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { planMobileTerminalTabMount } from '@/lib/mobile-terminal-tab-mount'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type {
  TerminalTabMountOutcome,
  TerminalTabMountRequestPayload
} from '../../../../shared/terminal-tab-mount-ack'
import { useAppStore } from '../../store'

export type TerminalTabMountRequest = TerminalTabMountRequestPayload

/** Main waits a little longer than this for the reply (RENDERER_TAB_MOUNT_ACK_TIMEOUT_MS). */
const TERMINAL_TAB_MOUNT_ACK_TIMEOUT_MS = 5_000
const TERMINAL_TAB_MOUNT_ACK_POLL_MS = 100

/**
 * Background-mounts a runtime-subscribed tab's PTY without navigating the desktop (STA-1840).
 * Only the phone's own per-terminal open (personOpen) is a person opening that tab, so only it
 * releases an agent the restore flood guard holds — also when the desktop already has the pane
 * mounted. A paired desktop client subscribing the tabs it mounts, or a snapshot remount, mounts
 * without counting as anyone's reveal. A request with `requestId` is acknowledged for its exact
 * surface once that tab's pane is mounted, or refused.
 */
export function handleTerminalTabMountRequest(request: TerminalTabMountRequest): void {
  const { worktreeId, tabId, ptyId, personOpen, requestId, leafId } = request
  if (!worktreeId) {
    return
  }
  const refusal = requestId && tabId ? exactSurfaceRefusal(worktreeId, tabId, leafId) : null
  if (requestId && tabId && refusal) {
    replyTerminalTabMount({ requestId, worktreeId, tabId, leafId }, refusal)
    return
  }
  const target = { worktreeId, ...(tabId ? { tabId } : {}), ...(ptyId ? { ptyId } : {}) }
  if (personOpen === true) {
    const revealedTabId = planMobileTerminalTabMount(useAppStore.getState(), target)?.tabIds?.[0]
    if (revealedTabId) {
      revealTerminalTabForPerson(revealedTabId)
    }
  }
  // Why: synthetic pty handles need persisted-tab resolution; a miss must not mount every saved tab in a hidden worktree.
  const mount = planMobileTerminalTabMount(useAppStore.getState(), target, {
    isTabMounted: hasRegisteredRuntimeTerminalTab
  })
  if (mount) {
    requestBackgroundTerminalWorktreeMount(mount)
  }
  if (requestId && tabId) {
    void acknowledgeWhenMounted({ requestId, worktreeId, tabId, leafId })
  }
}

type AckTarget = { requestId: string; worktreeId: string; tabId: string; leafId?: string }

function exactSurfaceRefusal(
  worktreeId: string,
  tabId: string,
  leafId: string | undefined
): TerminalTabMountOutcome | null {
  const state = useAppStore.getState()
  if (!(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
    return 'tab_not_found'
  }
  if (!leafId || !isTerminalLeafId(leafId)) {
    return null
  }
  const leafIds = collectLeafIdsInOrder(state.terminalLayoutsByTabId[tabId]?.root).filter(
    isTerminalLeafId
  )
  return leafIds.length > 0 && !leafIds.includes(leafId) ? 'leaf_not_found' : null
}

async function acknowledgeWhenMounted(target: AckTarget): Promise<void> {
  const deadline = Date.now() + TERMINAL_TAB_MOUNT_ACK_TIMEOUT_MS
  while (!hasRegisteredRuntimeTerminalTab(target.tabId)) {
    if (Date.now() >= deadline) {
      replyTerminalTabMount(target, 'mount_timeout')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_TAB_MOUNT_ACK_POLL_MS))
  }
  replyTerminalTabMount(target, 'mounted')
}

function replyTerminalTabMount(target: AckTarget, outcome: TerminalTabMountOutcome): void {
  window.api.ui.replyTerminalTabMount?.({
    requestId: target.requestId,
    worktreeId: target.worktreeId,
    tabId: target.tabId,
    ...(target.leafId ? { leafId: target.leafId } : {}),
    outcome
  })
}
