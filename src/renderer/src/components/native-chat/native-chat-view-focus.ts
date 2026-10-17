import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'

let focusGeneration = 0

/** Wait for React's layout effects and ignore a superseded switch. */
export function focusNativeChatView(
  worktreeId: string,
  unifiedTabId: string,
  terminalTabId: string,
  leafId: string | null | undefined,
  mode: 'chat' | 'terminal'
): void {
  const generation = ++focusGeneration
  requestAnimationFrame(() => {
    if (generation !== focusGeneration) {
      return
    }
    const current = useAppStore
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === unifiedTabId)
    if (!current || (current.viewMode ?? 'terminal') !== mode) {
      return
    }
    const pane = document.querySelector(`[data-terminal-tab-id="${CSS.escape(terminalTabId)}"]`)
    if (mode === 'terminal') {
      focusTerminalTabSurface(terminalTabId, leafId, { refreshImeContext: true })
      return
    }
    const chat = pane?.querySelector('.native-chat-pane-shell:not([aria-hidden="true"])')
    const input =
      chat?.querySelector<HTMLElement>('[data-native-chat-composer] textarea:not(:disabled)') ??
      chat?.querySelector<HTMLElement>('[data-native-chat-root]')
    input?.focus({ preventScroll: true })
  })
}
