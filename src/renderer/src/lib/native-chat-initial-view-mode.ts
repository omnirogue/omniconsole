import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { nativeChatEnabledByPreference } from '../../../shared/native-chat-preference'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import {
  canRenderNativeChatForAgent,
  nativeChatRequiresLocalTranscript
} from '@/lib/native-chat-supported-agent'

export type NativeChatLaunchPromptDelivery = 'auto-submit' | 'draft' | 'submit-after-ready'

/**
 * Decide the initial `viewMode` for a newly launched agent tab from the
 * opt-in `openAgentTabsInChatByDefault` setting.
 *
 * Returns `'chat'` only when the setting is explicitly on and the launched
 * agent has a native-chat renderer. A draft launch opens in chat only when its
 * unsent context can be mirrored into the composer — gated on the same
 * predicate as seeding so the view never opens empty beside a filled TUI input.
 */
export function decideInitialAgentTabViewMode(args: {
  experimentalNativeChat?: boolean
  openAgentTabsInChatByDefault?: boolean
  /** A per-launch choice (a saved launch favourite) that replaces the global default. */
  preferredViewMode?: 'chat' | 'terminal'
  agent?: TuiAgent | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  /** The unsent launch context, when `promptDelivery` is `'draft'`. */
  launchDraftText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
}): Tab['viewMode'] {
  const wantsChat = args.preferredViewMode
    ? args.preferredViewMode === 'chat'
    : args.openAgentTabsInChatByDefault === true
  if (!nativeChatEnabledByPreference(args) || !wantsChat) {
    return undefined
  }
  if (!canRenderNativeChatForAgent(args.agent)) {
    return undefined
  }
  if (
    nativeChatRequiresLocalTranscript(args.agent) &&
    args.nativeChatTranscriptIsLocalReadable !== true
  ) {
    return undefined
  }
  if (
    args.promptDelivery === 'draft' &&
    !canMirrorLaunchDraftToNativeChat(args.launchDraftText ?? '')
  ) {
    return undefined
  }
  return 'chat'
}

export function initialAgentTabViewModeProps(
  settings:
    | Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'>
    | null
    | undefined,
  options: {
    agent?: TuiAgent | null
    promptDelivery?: NativeChatLaunchPromptDelivery
    launchDraftText?: string
    nativeChatTranscriptIsLocalReadable?: boolean
    preferredViewMode?: 'chat' | 'terminal'
  } = {}
): { viewMode?: Tab['viewMode'] } {
  const viewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
    preferredViewMode: options.preferredViewMode,
    agent: options.agent,
    promptDelivery: options.promptDelivery,
    launchDraftText: options.launchDraftText,
    nativeChatTranscriptIsLocalReadable: options.nativeChatTranscriptIsLocalReadable
  })
  return viewMode ? { viewMode } : {}
}
