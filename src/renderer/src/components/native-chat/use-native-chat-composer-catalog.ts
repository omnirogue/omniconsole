import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

/**
 * What the `/` menu offers.
 *
 * A structured session offers only what the dispatcher can carry out: the
 * conversation commands the session itself reported. Listing the agent's own TUI
 * catalog there answered every pick with "not available in chat sessions". The
 * curated per-agent catalog remains the answer for the PTY lane.
 *
 * Scoped to this fork: upstream's version also folds in the session's reported
 * slash commands and skill names (#19127), which is not ported here.
 */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): readonly SlashCommandSuggestion[] {
  const structured = Boolean(structuredTransport)
  const conversationCommands = structuredTransport?.conversationCommands
  return useMemo(
    () =>
      structured
        ? structuredSlashCommands(conversationCommands)
        : getVerifiedNativeChatCommands(agent),
    [agent, conversationCommands, structured]
  )
}
