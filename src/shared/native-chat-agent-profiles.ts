import type { AgentType } from './agent-status-types'
import { getAgentSlashCommands, type SlashCommandSuggestion } from './native-chat-slash-commands'

export type NativeChatAgentProfile = {
  skillPrefix: '$' | '/'
  groupedSlash: boolean
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: AgentType
}

const NATIVE_CHAT_AGENT_PROFILES: Partial<Record<AgentType, NativeChatAgentProfile>> = {
  codex: {
    skillPrefix: '$',
    groupedSlash: false,
    skillSourceOwner: 'codex'
  },
  claude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude'
  },
  openclaude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude'
  },
  pi: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'pi'
  },
  'prime-agent': {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'prime-agent'
  },
  grok: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'grok'
  }
}

export function getNativeChatAgentProfile(
  agent: AgentType | null | undefined
): NativeChatAgentProfile | null {
  return agent ? (NATIVE_CHAT_AGENT_PROFILES[agent] ?? null) : null
}

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. Grok, Pi and Prime have no verified catalog yet,
 *  so their slash surfaces stay skills-only — this is the single place that policy lives. */
export function getVerifiedNativeChatCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return agent === 'grok' || agent === 'pi' || agent === 'prime-agent'
    ? []
    : getAgentSlashCommands(agent)
}
