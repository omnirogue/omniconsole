/** All AI coding agents OmniConsole knows how to launch. Used for the agent picker in the new-workspace
 *  flow and for the default-agent setting. Extend this union as new agents are added. */
export type TuiAgent =
  | 'claude' // Claude Code
  | 'claude-agent-teams' // Claude Code Agent Teams via OmniConsole native panes
  | 'openclaude' // OpenClaude
  | 'codex' // OpenAI Codex
  | 'muse' // Meta Muse Code
  | 'autohand' // Autohand Code CLI
  | 'opencode' // OpenCode
  | 'mimo-code'
  | 'pi' // Pi (pi.dev)
  | 'omp' // OMP (omp.sh)
  | 'gemini' // Gemini CLI
  | 'antigravity' // Google Antigravity CLI
  | 'aider' // Aider
  | 'goose' // Goose
  | 'amp' // Amp
  | 'kilo' // Kilocode
  | 'kiro' // Kiro
  | 'crush' // Charm/Crush
  | 'aug' // Augment/Auggie
  | 'cline' // Cline
  | 'codebuff' // Codebuff
  | 'command-code' // Command Code
  | 'continue' // Continue
  | 'cursor' // Cursor
  | 'droid' // Factory Droid
  | 'kimi' // Kimi
  | 'deepseek' // DeepSeek CLI
  | 'mistral-vibe' // Mistral Vibe
  | 'qwen-code' // Qwen Code
  | 'rovo' // Rovo Dev
  | 'hermes' // Hermes Agent
  | 'openclaw' // OpenClaw
  | 'copilot' // GitHub Copilot CLI
  | 'grok' // xAI Grok CLI
  | 'devin' // Devin CLI
  | 'ante' // Ante (Antigma Labs)
  | 'trae' // Trae CLI
  | 'prime-agent' // Prime Agent (Prime Intellect)

export const TUI_AGENT_VALUES: readonly TuiAgent[] = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'muse',
  'autohand',
  'opencode',
  'mimo-code',
  'pi',
  'omp',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'deepseek',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'openclaw',
  'copilot',
  'grok',
  'devin',
  'ante',
  'trae',
  'prime-agent'
] as const

export function isTuiAgent(value: unknown): value is TuiAgent {
  return typeof value === 'string' && (TUI_AGENT_VALUES as readonly string[]).includes(value)
}
