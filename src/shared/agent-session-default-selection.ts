import type { TuiAgent } from './tui-agent'
import { hasFlag } from './agent-cli-flag-detection'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

/** Defaults defer to an explicit CLI, profile, command or environment selection. */
export function hasExplicitAgentSessionDefaultSelection(input: {
  agent: TuiAgent
  agentArgs?: string | null
  commandOverride?: string
  env?: Readonly<Record<string, string | undefined>>
  shell: AgentStartupShell
  effortOnly?: boolean
}): boolean {
  const args = tokenizeStartupCommand(input.agentArgs ?? '', input.shell)
  return Boolean(
    input.commandOverride ||
    !args.ok ||
    (args.ok &&
      getAgentSessionOptionCatalog(input.agent)
        ?.unknownModelOptions?.find((option) => option.id === 'effort')
        ?.apply.agentArgsOverride?.(args.tokens)) ||
    (args.ok &&
      hasFlag(args.tokens, [
        '--effort',
        '--reasoning-effort',
        '--profile',
        '--config',
        '--oss',
        '--local-provider',
        '--settings',
        '--setting-sources',
        ...(!input.effortOnly ? ['--model', '-m'] : []),
        ...(input.agent === 'codex' ? ['-c', '-p'] : [])
      ])) ||
    ['ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'OPENAI_MODEL'].some((key) => input.env?.[key])
  )
}
