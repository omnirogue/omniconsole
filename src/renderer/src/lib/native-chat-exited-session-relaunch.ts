import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '@/store'
import { launchSleepingAgentSession } from './sleeping-agent-session-launch'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { seedNativeChatLaunchDraftForAgentTab } from './agent-launch-prompt-delivery'

/** What the exited pane still holds: the message that never reached the model, if any. */
function readUndeliveredLaunchPrompt(terminalTabId: string): string | null {
  const state = useAppStore.getState()
  const prompt = state.nativeChatLaunchPromptByTabId[terminalTabId]
  if (!prompt || prompt.text.trim().length === 0) {
    return null
  }
  return prompt.text
}

function carryDraft(tabId: string, agent: TuiAgent, text: string | null): void {
  if (text) {
    // Why a draft, not a send: the person decides whether the message still applies.
    seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text })
  }
}

/** Reopen the same provider session in a new tab; the unsent message rides along as a draft. */
export function resumeExitedNativeChatSession(args: {
  terminalTabId: string
  record: SleepingAgentSessionRecord
}): boolean {
  const pending = readUndeliveredLaunchPrompt(args.terminalTabId)
  const launched = launchSleepingAgentSession(args.record, {
    viewMode: 'chat',
    onSessionLaunched: (tabId) => carryDraft(tabId, args.record.agent, pending)
  })
  if (launched) {
    useAppStore.getState().clearNativeChatLaunchPrompt(args.terminalTabId)
  }
  return launched
}

/** Start the agent fresh in a new tab when no resumable session was ever recorded. */
export function restartExitedNativeChatAgent(args: {
  terminalTabId: string
  agent: TuiAgent
  worktreeId: string
}): boolean {
  const pending = readUndeliveredLaunchPrompt(args.terminalTabId)
  const result = launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    ...(pending ? { prompt: pending, promptDelivery: 'draft' as const } : {}),
    launchSource: 'sidebar',
    viewModePreference: 'chat'
  })
  if (result !== null) {
    useAppStore.getState().clearNativeChatLaunchPrompt(args.terminalTabId)
  }
  return result !== null
}
