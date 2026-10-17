import type { SleepingAgentLaunchConfig } from './agent-session-resume'

/**
 * The model and effort a running Claude/Codex was started with, read back from its command line,
 * and written into a sleeping record so a wake resumes with them. Why: picker flags are left out
 * of `launchConfig` on purpose (tui-agent-startup.ts), but a review wake must resume exactly.
 */
export type AgentLaunchOptions = { model?: string; effort?: string }

const VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function unquote(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, '')
}

function clean(value: string | undefined): string | undefined {
  const text = value === undefined ? undefined : unquote(value)
  return text && VALUE.test(text) ? text : undefined
}

function flagValue(tokens: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]!)
    if (token === '--') {
      return undefined
    }
    for (const name of names) {
      if (token === name) {
        return clean(tokens[index + 1])
      }
      if (token.startsWith(`${name}=`)) {
        return clean(token.slice(name.length + 1))
      }
    }
  }
  return undefined
}

function codexEffort(tokens: readonly string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]!)
    if (token === '--') {
      return undefined
    }
    const config =
      token === '-c' || token === '--config'
        ? unquote(tokens[index + 1] ?? '')
        : token.startsWith('--config=')
          ? unquote(token.slice('--config='.length))
          : null
    const match = config?.match(/^model_reasoning_effort=(.+)$/)
    if (match) {
      return clean(match[1])
    }
  }
  return undefined
}

/** Whitespace tokens are enough here: model ids and effort levels never contain spaces. */
export function agentLaunchOptionsFromCommand(
  agent: 'claude' | 'codex',
  command: string
): AgentLaunchOptions {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  const model = flagValue(tokens, agent === 'codex' ? ['--model', '-m'] : ['--model'])
  const effort = agent === 'codex' ? codexEffort(tokens) : flagValue(tokens, ['--effort'])
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

function missingArgs(
  agent: 'claude' | 'codex',
  existing: string,
  options: AgentLaunchOptions
): string[] {
  const have = agentLaunchOptionsFromCommand(agent, existing)
  const args: string[] = []
  const model = clean(options.model)
  const effort = clean(options.effort)
  if (model && !have.model) {
    args.push('--model', model)
  }
  if (effort && !have.effort) {
    args.push(
      ...(agent === 'codex' ? ['-c', `model_reasoning_effort=${effort}`] : ['--effort', effort])
    )
  }
  return args
}

/**
 * The record's launch config with any missing model/effort flags added; unchanged otherwise.
 * Unquoted on purpose: `VALUE` admits no character any supported shell treats specially.
 */
export function withAgentLaunchOptions(
  config: SleepingAgentLaunchConfig | undefined,
  agent: 'claude' | 'codex',
  options: AgentLaunchOptions | undefined
): SleepingAgentLaunchConfig | undefined {
  if (!config || !options) {
    return config
  }
  const args = missingArgs(agent, `${config.agentCommand ?? ''} ${config.agentArgs}`, options)
  if (args.length === 0) {
    return config
  }
  const suffix = args.join(' ')
  return {
    ...config,
    ...(config.agentCommand ? { agentCommand: `${config.agentCommand} ${suffix}` } : {}),
    agentArgs: [config.agentArgs.trim(), suffix].filter(Boolean).join(' ')
  }
}
