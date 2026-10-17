import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { resolveNativeChatSessionOptionDefaults } from '../../../../shared/native-chat-session-option-defaults'
import { hasExplicitAgentSessionDefaultSelection } from '../../../../shared/agent-session-default-selection'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'
import { resolveNativeChatLaunchSessionOptions } from './native-chat-session-option-enrichment'

type NativeChatLaunchSettings = Pick<
  GlobalSettings,
  'experimentalNativeChat' | 'openAgentTabsInChatByDefault' | 'nativeChatSessionOptions'
> &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>

export type InitialNativeChatSessionOptionsArgs = {
  agent: TuiAgent
  preferredViewMode?: 'chat' | 'terminal'
  agentArgs?: string | null
  agentEnv?: Readonly<Record<string, string>>
  agentCommandOverride?: string
  shell?: AgentStartupShell
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}

export function resolveInitialNativeChatSessionOptions(
  settings: NativeChatLaunchSettings | null | undefined,
  args: InitialNativeChatSessionOptionsArgs
): Record<string, SessionOptionValue> | undefined {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
    ...args
  })
  if (viewMode === 'chat') {
    return resolveNativeChatLaunchSessionOptions(settings?.nativeChatSessionOptions, args.agent)
  }
  const commandOverride = args.agentCommandOverride ?? settings?.agentCmdOverrides?.[args.agent]
  if (!['claude', 'codex'].includes(args.agent) || commandOverride) {
    return undefined
  }
  if (
    hasExplicitAgentSessionDefaultSelection({
      agent: args.agent,
      agentArgs: args.agentArgs,
      commandOverride,
      env: args.agentEnv,
      shell: args.shell ?? 'posix',
      effortOnly: true
    })
  ) {
    return undefined
  }
  // A saved effort may seed a terminal; its model remains the CLI's choice.
  const saved = resolveNativeChatSessionOptionDefaults(
    settings?.nativeChatSessionOptions,
    args.agent
  )
  return typeof saved?.effort === 'string' ? { effort: saved.effort } : undefined
}
