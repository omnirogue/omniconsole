import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../../store/types'
import type { NativeChatAgentExit } from './native-chat-view-types'
import { findTabSleepingAgentRecord } from './native-chat-tab-sleeping-record'

export type NativeChatAgentExitSlice = Pick<
  AppState,
  | 'sleepingAgentSessionsByPaneKey'
  | 'paneForegroundAgentByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'nativeChatLaunchPromptByTabId'
  | 'tabsByWorktree'
>

function firstByTabPrefix<T>(
  records: Readonly<Record<string, T>>,
  terminalTabId: string
): T | null {
  const prefix = `${terminalTabId}:`
  for (const [paneKey, value] of Object.entries(records)) {
    if (paneKey.startsWith(prefix)) {
      return value
    }
  }
  return null
}

function worktreeIdForTab(slice: NativeChatAgentExitSlice, terminalTabId: string): string | null {
  for (const [worktreeId, tabs] of Object.entries(slice.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === terminalTabId)) {
      return worktreeId
    }
  }
  return null
}

/**
 * Exit evidence for a chat pane. A launched agent is "gone" when no live status
 * row remains and the pane's foreground is proven back at the shell (or the PTY
 * itself is gone) — and something says an agent was here: a resume checkpoint,
 * a retained status snapshot, or a launch prompt whose delivery failed. Startup
 * looks the same as exit for the first seconds (shell, no row), which is why a
 * bare shell reading is never enough on its own. Panes without process
 * inspection (remote/SSH) substitute the title reverting to a plain shell.
 */
export function deriveNativeChatAgentExit(
  slice: NativeChatAgentExitSlice,
  args: {
    terminalTabId: string
    paneKey: string
    targetPtyId: string | null
    hasLiveEntry: boolean
  }
): { record: SleepingAgentSessionRecord | null; agentExit: NativeChatAgentExit | null } {
  const record = findTabSleepingAgentRecord(
    slice.sleepingAgentSessionsByPaneKey,
    args.terminalTabId,
    args.paneKey
  )
  if (args.hasLiveEntry) {
    return { record, agentExit: null }
  }
  const foreground = slice.paneForegroundAgentByPaneKey[args.paneKey]
  const shellForeground =
    (foreground?.shellForeground === true || foreground?.shellTitleReverted === true) &&
    !foreground.agent
  const retained = Boolean(
    slice.retainedAgentsByPaneKey[args.paneKey] ??
    firstByTabPrefix(slice.retainedAgentsByPaneKey, args.terminalTabId)
  )
  const launchPrompt = slice.nativeChatLaunchPromptByTabId[args.terminalTabId]
  const promptFailed = launchPrompt?.failed === true
  // A first-reveal checkpoint is a resume still pending in this tab, not an exited agent.
  const gone =
    args.targetPtyId === null
      ? record !== null && record.resumeOnFirstReveal !== true
      : shellForeground
  if (!gone || !(record || retained || promptFailed)) {
    return { record, agentExit: null }
  }
  return {
    record,
    agentExit: {
      resumeRecord: record,
      worktreeId: worktreeIdForTab(slice, args.terminalTabId) ?? record?.worktreeId ?? null,
      hasUndeliveredPrompt: Boolean(launchPrompt && launchPrompt.text.trim().length > 0)
    }
  }
}
