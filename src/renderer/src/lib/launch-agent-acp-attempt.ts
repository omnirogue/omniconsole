import { isAcpStructuredAgent } from '../../../shared/acp-agent-recipes'
import { isAcpEnabled } from '../../../shared/acp-launch-support'
import { launchAcpChat } from './launch-acp-chat'
import { describeStructuredNativeChatHostSupport } from '@/lib/structured-native-chat-availability'
import type { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab-types'

/**
 * Routes a chat-mode launch through the ACP transport when the agent is ACP-enabled and the host
 * probe supports it; falls back to the normal PTY path (via `relaunch`) otherwise.
 */
export function attemptAcpChatLaunch(input: {
  args: LaunchAgentInNewTabArgs
  store: ReturnType<typeof useAppStore.getState>
  acpChatLaunch: boolean
  startupPlan: AgentStartupPlan
  sessionOptions: Record<string, SessionOptionValue> | undefined
  hasPrompt: boolean
  promptDelivery: string
  trimmedPrompt: string
  relaunch: () => LaunchAgentInNewTabResult
}): LaunchAgentInNewTabResult | null {
  const {
    args,
    store,
    acpChatLaunch,
    startupPlan,
    sessionOptions,
    hasPrompt,
    promptDelivery,
    trimmedPrompt,
    relaunch
  } = input
  const { agent, worktreeId, onPromptDelivered, agentArgs, launchEnv, initialCwd } = args
  if (
    args.acpFallback ||
    !acpChatLaunch ||
    !isAcpStructuredAgent(agent) ||
    !isAcpEnabled(store.settings, agent)
  ) {
    return null
  }
  const hostSupport = describeStructuredNativeChatHostSupport(store, worktreeId)
  const refusal =
    (hasPrompt && promptDelivery === 'draft') ||
    agentArgs?.trim() ||
    (launchEnv && Object.keys(launchEnv).length > 0) ||
    initialCwd?.trim() ||
    store.settings?.agentCmdOverrides?.[agent]?.trim()
      ? ('custom-launch' as const)
      : !hostSupport.supported
        ? hostSupport.reason === 'repair-required'
          ? ('initialize-failed' as const)
          : hostSupport.reason
        : undefined
  return {
    tabId: null,
    startupPlan,
    pasteDraftAfterLaunch: false,
    focusAfterMenuClose: 'structured-session',
    promptDeliveryResult: launchAcpChat({
      agent,
      worktreeId,
      refusal,
      options: sessionOptions,
      prompt: hasPrompt && promptDelivery !== 'draft' ? trimmedPrompt : undefined,
      onPromptDelivered,
      launchKey: args.submissionId ?? args.reservedConversationTabId,
      navigate: args.navigate,
      groupId: args.groupId,
      onSessionCreated: args.onSessionCreated,
      fallback: async () => {
        const result = relaunch()
        return (
          result?.promptDeliveryResult ?? { delivered: result !== null, failureNotified: false }
        )
      }
    })
  }
}

/** Whether a chat-mode launch for this agent should route through ACP instead of PTY. */
export function shouldAttemptAcpChatLaunch(
  store: ReturnType<typeof useAppStore.getState>,
  agent: TuiAgent,
  viewModePreference: 'chat' | 'terminal' | undefined
): boolean {
  return (
    isAcpEnabled(store.settings, agent) &&
    store.settings?.experimentalNativeChat !== false &&
    viewModePreference !== 'terminal' &&
    (viewModePreference === 'chat' || store.settings?.openAgentTabsInChatByDefault === true)
  )
}
