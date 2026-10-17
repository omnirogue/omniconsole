import { focusRendererTerminalHandle } from '@/components/terminal-pane/terminal-handle-links'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

/**
 * Brings a worker's own terminal forward by its handle: the tab mounted in this window when there
 * is one, else the host navigates to it (a child worktree, or a tab not mounted yet).
 */
export async function openWorkerTerminal(handle: string): Promise<void> {
  if (!focusRendererTerminalHandle(handle, null)) {
    await callRuntimeRpc({ kind: 'local' }, 'terminal.focus', {
      terminal: handle,
      navigation: 'host'
    })
  }
}
