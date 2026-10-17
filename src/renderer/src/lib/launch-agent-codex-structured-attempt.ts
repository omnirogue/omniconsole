import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { describeStructuredNativeChatHostSupport } from '@/lib/structured-native-chat-availability'
import { decideStructuredCodexLaunch } from '@/lib/structured-codex-launch-decision'
import { explainStructuredCodexFallback } from '@/lib/structured-codex-launch-fallback'
import { startStructuredChatLaunch } from '@/lib/structured-agent-session-launch'
import type { useAppStore } from '@/store'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab-types'

/**
 * Routes a Codex chat launch to the app-server runtime, or explains why it is not.
 *
 * Lifted out of launch-agent-in-new-tab.ts so the three structured lanes — ACP,
 * Claude Agent SDK, Codex app-server — are each one named attempt with the same
 * shape, and so that file stays inside its line budget. The decision itself is
 * unchanged and still lives in structured-codex-launch-decision.ts.
 *
 * Returns null when this launch is not a Codex structured candidate, which leaves
 * the terminal path below it to run exactly as before.
 */
export function attemptCodexStructuredChatLaunch(input: {
  args: LaunchAgentInNewTabArgs
  store: ReturnType<typeof useAppStore.getState>
  startupPlan: AgentStartupPlan
  sessionOptions: Record<string, SessionOptionValue> | undefined
  hasPrompt: boolean
  promptDelivery: string
  trimmedPrompt: string
  shell: AgentStartupShell
}): LaunchAgentInNewTabResult | null {
  const { args, store, startupPlan } = input
  const decision = decideStructuredCodexLaunch({
    agent: args.agent,
    settings: store.settings ?? null,
    hostSupport: () => describeStructuredNativeChatHostSupport(store, args.worktreeId),
    customAgentArgs: args.agentArgs,
    launchEnv: args.launchEnv,
    shell: input.shell
  })
  // Why: the ACP and Claude lanes both stand down for an explicit terminal launch, but this
  // decision reads only the saved default view — so honour the per-launch choice here too.
  if (args.acpFallback || args.viewModePreference === 'terminal') {
    return null
  }
  if (!decision.structured) {
    if (decision.explain) {
      explainStructuredCodexFallback(decision)
    }
    return null
  }
  // Why: model/effort ride on the session record for the first turn and the
  // prompt drains from the outbox once the chat attaches — one accepted turn,
  // never a keystroke into a startup menu.
  return {
    tabId: null,
    startupPlan,
    pasteDraftAfterLaunch: false,
    focusAfterMenuClose: 'structured-session',
    promptDeliveryResult: startStructuredChatLaunch(
      args.worktreeId,
      input.sessionOptions,
      input.hasPrompt && input.promptDelivery !== 'draft' ? input.trimmedPrompt : undefined,
      args.onPromptDelivered,
      undefined,
      'acp',
      {
        launchKey: args.submissionId ?? args.reservedConversationTabId,
        navigate: args.navigate,
        groupId: args.groupId,
        onSessionCreated: args.onSessionCreated
      }
    )
  }
}
