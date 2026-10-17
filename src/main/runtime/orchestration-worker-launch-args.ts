import type { LaunchCause } from '../../shared/launch-cause'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'

const CODEX_STARTUP_UPDATE_KEY = 'check_for_update_on_startup'

function isStartupUpdateConfig(value: string): boolean {
  return value.split('=', 1)[0].trim() === CODEX_STARTUP_UPDATE_KEY && value.includes('=')
}

export type OrchestrationWorkerLaunchArgs = {
  agent: TuiAgent
  launchCause?: Pick<LaunchCause, 'trigger'>
  /** The operator's own CLI arguments, before any managed-launch rewrite. */
  agentArgs: string
  shell: AgentStartupShell
}

function isManagedCodexLaunch(args: OrchestrationWorkerLaunchArgs): boolean {
  return (
    args.agent === 'codex' &&
    ['orchestration-worker', 'hibernation-wake'].includes(args.launchCause?.trigger ?? '')
  )
}

/** Managed task delivery and review wakes must never answer Codex's interactive updater. */
export function orchestrationWorkerLaunchArgs(args: OrchestrationWorkerLaunchArgs): string {
  if (!isManagedCodexLaunch(args)) {
    return args.agentArgs
  }
  const parsed = tokenizeStartupCommand(args.agentArgs, args.shell)
  if (!parsed.ok) {
    throw new Error(`CLI arguments are invalid: ${parsed.error}`)
  }
  const retained: string[] = []
  let index = 0
  for (; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index]
    if (token === '--') {
      break
    }
    if (
      (token === '-c' || token === '--config') &&
      isStartupUpdateConfig(parsed.tokens[index + 1] ?? '')
    ) {
      index += 1
      continue
    }
    const inlineConfig = token.startsWith('--config=')
      ? token.slice('--config='.length)
      : token.startsWith('-c=')
        ? token.slice(3)
        : token.startsWith('-c')
          ? token.slice(2)
          : ''
    if (!isStartupUpdateConfig(inlineConfig)) {
      retained.push(token)
    }
  }
  retained.push('-c', `${CODEX_STARTUP_UPDATE_KEY}=false`, ...parsed.tokens.slice(index))
  return retained.map((token) => quoteStartupArg(token, args.shell)).join(' ')
}

type DurableLaunchConfig = { agentCommand?: string; agentArgs: string }

/**
 * The durable launch record replays `agentCommand` verbatim on every later resume, including a
 * person's. The updater suppression is scoped to the managed launch that asked for it, so the
 * record keeps the operator's own arguments and command instead of the rewritten ones.
 */
export function durableWorkerLaunchConfig<T extends DurableLaunchConfig | undefined>(
  launchConfig: T,
  args: OrchestrationWorkerLaunchArgs
): T {
  if (!launchConfig || !isManagedCodexLaunch(args)) {
    return launchConfig
  }
  const managedArgs = orchestrationWorkerLaunchArgs(args)
  const managedSuffix = planAgentCliArgsSuffix(managedArgs, args.shell)
  const ownSuffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  const durable: DurableLaunchConfig = { ...launchConfig }
  if (durable.agentArgs === managedArgs) {
    durable.agentArgs = args.agentArgs
  }
  const command = durable.agentCommand
  if (
    command !== undefined &&
    managedSuffix.ok &&
    ownSuffix.ok &&
    managedSuffix.suffix &&
    command.endsWith(` ${managedSuffix.suffix}`)
  ) {
    const base = command.slice(0, command.length - managedSuffix.suffix.length - 1)
    durable.agentCommand = ownSuffix.suffix ? `${base} ${ownSuffix.suffix}` : base
  }
  return durable as T
}
