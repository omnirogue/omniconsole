/** Agents whose Native Chat composer is an ACP stdio child. */

export const ACP_STRUCTURED_AGENTS = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'cursor',
  'goose',
  'cline',
  'mistral-vibe',
  'kimi',
  'gemini',
  'copilot',
  'kiro',
  'opencode',
  'qwen-code',
  'omp'
] as const

export type AcpStructuredAgent = (typeof ACP_STRUCTURED_AGENTS)[number]

export type AcpSpawnRecipe = {
  program: string
  args: readonly string[]
}

export function isAcpStructuredAgent(
  agent: string | null | undefined
): agent is AcpStructuredAgent {
  return agent != null && (ACP_STRUCTURED_AGENTS as readonly string[]).includes(agent)
}

export function acpHandleProvider(agent: string): Exclude<AcpStructuredAgent, 'openclaude'> | null {
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (isAcpStructuredAgent(agent) && agent !== 'openclaude') {
    return agent
  }
  return null
}

export function acpAccountHomeVariable(
  agent: string
): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'GROK_HOME' | 'CURSOR_CONFIG_DIR' | 'HOME' | null {
  const provider = acpHandleProvider(agent)
  if (provider === 'claude') {
    return 'CLAUDE_CONFIG_DIR'
  }
  if (provider === 'codex') {
    return 'CODEX_HOME'
  }
  if (provider === 'grok') {
    return 'GROK_HOME'
  }
  if (provider === 'cursor') {
    return 'CURSOR_CONFIG_DIR'
  }
  return isAcpStructuredAgent(agent) ? 'HOME' : null
}

/** Pinned so a launch runs reviewed adapter code instead of whatever the registry publishes next. */
const CLAUDE_ACP_ADAPTER = '@agentclientprotocol/claude-agent-acp@0.74.0'
const CODEX_ACP_ADAPTER = '@agentclientprotocol/codex-acp@1.10.0'

export function acpSpawnRecipe(agent: string): AcpSpawnRecipe | null {
  switch (agent) {
    case 'goose':
      return { program: 'goose', args: ['acp'] }
    case 'cline':
      return { program: 'cline', args: ['--acp'] }
    case 'mistral-vibe':
      return { program: 'vibe-acp', args: [] }
    case 'kimi':
      return { program: 'kimi', args: ['acp'] }
    case 'gemini':
      return { program: 'gemini', args: ['--experimental-acp'] }
    case 'copilot':
      return { program: 'copilot', args: ['--acp', '--stdio'] }
    case 'kiro':
      return { program: 'kiro-cli', args: ['acp'] }
    case 'opencode':
      return { program: 'opencode', args: ['acp'] }
    case 'qwen-code':
      return { program: 'qwen', args: ['--acp'] }
    case 'omp':
      return { program: 'omp', args: ['acp'] }
    case 'grok':
      return { program: 'grok', args: ['agent', 'stdio'] }
    case 'cursor':
      return { program: 'agent', args: ['acp'] }
    case 'claude':
    case 'openclaude':
      return { program: 'npx', args: ['-y', CLAUDE_ACP_ADAPTER] }
    case 'codex':
      return { program: 'npx', args: ['-y', CODEX_ACP_ADAPTER] }
    default:
      return null
  }
}
