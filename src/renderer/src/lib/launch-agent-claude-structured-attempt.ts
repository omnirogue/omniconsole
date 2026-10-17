import { describeClaudeStructuredSdkSupport } from '../../../shared/claude-structured-sdk-support'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { describeStructuredNativeChatHostSupport } from '@/lib/structured-native-chat-availability'
import type { useAppStore } from '@/store'
import {
  explainClaudeStructuredFallback,
  launchClaudeStructuredChat,
  type ClaudeStructuredLaunchRefusal
} from './launch-claude-structured-chat'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab-types'

/**
 * Whether a chat-mode Claude launch should go to the Claude Agent SDK lane.
 *
 * Settings only. The host's own verdict — SDK present, platform supervisable,
 * managed account resolvable — is asked once the launch is actually taken, because
 * a client cannot observe any of it and guessing sends the launch to a lane the
 * host refuses.
 */
export function shouldAttemptClaudeStructuredLaunch(
  store: ReturnType<typeof useAppStore.getState>,
  agent: TuiAgent,
  viewModePreference: 'chat' | 'terminal' | undefined
): boolean {
  if (agent !== 'claude' || viewModePreference === 'terminal') {
    return false
  }
  return describeClaudeStructuredSdkSupport(store.settings).supported
}

type ClientRefusal = { reason: ClaudeStructuredLaunchRefusal; explain: boolean }

/** What about THIS launch, rather than this install, keeps it off the lane. */
function perLaunchRefusal(
  input: Pick<LaunchAgentInNewTabArgs, 'agentArgs' | 'launchEnv' | 'initialCwd' | 'agent'>,
  store: ReturnType<typeof useAppStore.getState>,
  hasDraftPrompt: boolean
): ClientRefusal | undefined {
  // A draft prompt opens the composer for editing rather than sending a turn, so it
  // was never a structured launch; saying so would be noise about a choice the
  // person made deliberately.
  if (hasDraftPrompt) {
    return { reason: 'draft-prompt', explain: false }
  }
  // The rest each pin something the structured launch resolver refuses to carry —
  // different arguments, a different command, a different account, or a different
  // directory. Running them anyway would silently launch something else.
  if (
    input.agentArgs?.trim() ||
    (input.launchEnv && Object.keys(input.launchEnv).length > 0) ||
    input.initialCwd?.trim() ||
    store.settings?.agentCmdOverrides?.[input.agent]?.trim()
  ) {
    return { reason: 'custom-launch', explain: true }
  }
  return undefined
}

/**
 * Routes a chat-mode Claude launch through the agent SDK, falling back to the normal
 * PTY path (via `relaunch`) with a stated reason otherwise.
 *
 * Returns null when this launch is not a candidate at all, which leaves the caller's
 * existing routing untouched — the Codex structured decision and the terminal path
 * both still run.
 */
export function attemptClaudeStructuredChatLaunch(input: {
  args: LaunchAgentInNewTabArgs
  store: ReturnType<typeof useAppStore.getState>
  claudeChatLaunch: boolean
  startupPlan: AgentStartupPlan
  sessionOptions: Record<string, SessionOptionValue> | undefined
  hasPrompt: boolean
  promptDelivery: string
  trimmedPrompt: string
  relaunch: () => LaunchAgentInNewTabResult
}): LaunchAgentInNewTabResult | null {
  const { args, store, startupPlan, relaunch } = input
  if (args.acpFallback || !input.claudeChatLaunch || args.agent !== 'claude') {
    return null
  }
  const hostSupport = describeStructuredNativeChatHostSupport(store, args.worktreeId)
  const refusal =
    perLaunchRefusal(args, store, input.hasPrompt && input.promptDelivery === 'draft') ??
    (hostSupport.supported
      ? undefined
      : ({ reason: hostSupport.reason, explain: true } satisfies ClientRefusal))
  // Explain and DECLINE, rather than taking the launch and falling back inside a
  // promise. A refusal this side of the host changes nothing about how the launch
  // should run, and deferring it would make the terminal tab appear a tick late —
  // which is the tick an argv-prefill draft is seeded into.
  if (refusal) {
    if (refusal.explain) {
      explainClaudeStructuredFallback(refusal.reason)
    }
    return null
  }
  return {
    tabId: null,
    startupPlan,
    pasteDraftAfterLaunch: false,
    focusAfterMenuClose: 'structured-session',
    promptDeliveryResult: launchClaudeStructuredChat({
      worktreeId: args.worktreeId,
      onSessionCreated: args.onSessionCreated,
      navigate: args.navigate,
      launchKey: args.submissionId ?? args.reservedConversationTabId,
      groupId: args.groupId,
      ...(input.sessionOptions ? { options: input.sessionOptions } : {}),
      ...(input.hasPrompt && input.promptDelivery !== 'draft'
        ? { prompt: input.trimmedPrompt }
        : {}),
      ...(args.onPromptDelivered ? { onPromptDelivered: args.onPromptDelivered } : {}),
      fallback: async () => {
        const result = relaunch()
        return (
          result?.promptDeliveryResult ?? { delivered: result !== null, failureNotified: false }
        )
      }
    })
  }
}
