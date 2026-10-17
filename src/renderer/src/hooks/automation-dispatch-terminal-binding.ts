import type { AutomationDispatchResult } from '../../../shared/automations-types'

export type AutomationDispatchTerminalBinding = Pick<
  AutomationDispatchResult,
  | 'workspaceId'
  | 'workspaceDisplayName'
  | 'ownsTerminal'
  | 'terminalSessionId'
  | 'terminalPaneKey'
  | 'terminalPtyId'
>

export function automationDispatchTerminalBinding(
  worktree: { id: string; displayName?: string },
  terminal: { tabId: string; paneKey: string; ptyId: string },
  ownsTerminal: boolean
): AutomationDispatchTerminalBinding {
  return {
    workspaceId: worktree.id,
    workspaceDisplayName: worktree.displayName ?? null,
    ownsTerminal,
    terminalSessionId: terminal.tabId,
    terminalPaneKey: terminal.paneKey,
    terminalPtyId: terminal.ptyId
  }
}
