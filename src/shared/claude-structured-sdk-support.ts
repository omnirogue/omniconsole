// Whether a Claude chat launch goes to the Claude Agent SDK lane (upstream #18560).
//
// Shared because the host and the launcher must agree: the renderer decides
// whether to even ask, and the host decides whether to admit. Two copies of this
// rule drift, and the drift is invisible — the launcher routes to a lane the
// host then refuses, which the user sees as a chat that opened in the terminal
// for no stated reason.

import { isAcpEnabled } from './acp-launch-support'
import type { GlobalSettings } from './global-settings-types'

export type ClaudeStructuredSdkSettings = Pick<
  GlobalSettings,
  | 'experimentalNativeChat'
  | 'openAgentTabsInChatByDefault'
  | 'experimentalStructuredNativeChat'
  | 'agentUseAcp'
>

/** Why a Claude launch is not taking the SDK lane. Keys, not prose, so the copy stays localized. */
export type ClaudeStructuredSdkRefusal =
  | 'chat-ui-off'
  | 'default-view-terminal'
  | 'structured-off'
  | 'acp'

export type ClaudeStructuredSdkSupport =
  | { supported: true }
  | { supported: false; reason: ClaudeStructuredSdkRefusal }

/**
 * The host-side gate: the experiment is on and the person has not opted Claude
 * into ACP. Deliberately narrower than the launcher's decision — the default
 * view and the chat-UI toggle are client-side preferences a paired client answers
 * for itself, exactly as they already are for Codex.
 */
export function isClaudeStructuredSdkEnabled(
  settings: ClaudeStructuredSdkSettings | null | undefined
): boolean {
  return settings?.experimentalStructuredNativeChat === true && !isAcpEnabled(settings, 'claude')
}

/** The launcher-side decision, with the reason a fallback toast names. */
export function describeClaudeStructuredSdkSupport(
  settings: ClaudeStructuredSdkSettings | null | undefined
): ClaudeStructuredSdkSupport {
  if (settings?.experimentalNativeChat === false) {
    return { supported: false, reason: 'chat-ui-off' }
  }
  if (settings?.openAgentTabsInChatByDefault !== true) {
    return { supported: false, reason: 'default-view-terminal' }
  }
  if (settings?.experimentalStructuredNativeChat !== true) {
    return { supported: false, reason: 'structured-off' }
  }
  // An explicit per-agent ACP opt-in is a deliberate choice of a different
  // structured lane, not a refusal: that path owns the launch from here.
  if (isAcpEnabled(settings, 'claude')) {
    return { supported: false, reason: 'acp' }
  }
  return { supported: true }
}
