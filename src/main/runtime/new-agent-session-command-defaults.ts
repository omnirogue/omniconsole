import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveAgentLaunchCommand } from '../../shared/tui-agent-launch-command'
import {
  tokenizeStartupCommand,
  resolveStartupShell,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { hasFlag } from '../../shared/agent-cli-flag-detection'
import { resolveNewAgentSessionDefaultsOnHost } from './new-agent-session-defaults-host'

/** Extend a known fresh managed plan. Its durable sleeping command stays stripped. */
export async function resolveNewAgentSessionCommandDefaults(input: {
  agent?: TuiAgent
  command?: string
  launchConfig?: SleepingAgentLaunchConfig | null
  continuation?: boolean
  /** The command resumes a recorded thread in a new pane (a routine's own `--resume`):
   *  it takes the defaults a fresh launch would, so its selector is not a legacy resume. */
  threadResume?: boolean
  settings: GlobalSettings
  env?: Record<string, string>
  accountHome?: string
  workspacePath: string
  connectionId?: string | null
  platform?: NodeJS.Platform
  shell?: AgentStartupShell
  resolveDefaults?: typeof resolveNewAgentSessionDefaultsOnHost
}): Promise<string | undefined> {
  const prefix = input.launchConfig?.agentCommand?.trim()
  if (
    input.continuation ||
    (input.agent !== 'claude' && input.agent !== 'codex') ||
    !input.command ||
    !prefix ||
    !(
      input.command === prefix ||
      input.command.startsWith(`${prefix} `) ||
      input.command.startsWith(`${prefix};`)
    )
  ) {
    return input.command
  }
  const platform = input.platform ?? process.platform
  const shell = input.shell ?? resolveStartupShell(platform)
  const tokens = tokenizeStartupCommand(input.command, shell)
  // Unknown raw commands and legacy resumes retain their original semantics.
  if (
    !tokens.ok ||
    (!input.threadResume &&
      (tokens.tokens.includes('resume') ||
        hasFlag(tokens.tokens, [
          '--resume',
          '--continue',
          ...(input.agent === 'claude' ? ['-r', '-c'] : [])
        ]))) ||
    hasFlag(tokens.tokens, [
      '--model',
      '--effort',
      '--reasoning-effort',
      '--profile',
      '--config',
      '--oss',
      '--local-provider',
      '-m',
      ...(input.agent === 'codex' ? ['-c', '-p'] : [])
    ])
  ) {
    return input.command
  }
  const accountHome =
    input.accountHome ??
    input.env?.[input.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] ??
    (!input.connectionId && !parseWslUncPath(input.workspacePath)
      ? input.agent === 'codex'
        ? getSystemCodexHomePath()
        : join(homedir(), '.claude')
      : undefined)
  const options = await (input.resolveDefaults ?? resolveNewAgentSessionDefaultsOnHost)({
    agent: input.agent,
    settings: input.settings,
    env: input.env,
    accountHome,
    workspacePath: input.workspacePath,
    connectionId: input.connectionId,
    agentArgs: input.command
  })
  if (!options?.model) {
    return input.command
  }
  const resolved = resolveAgentLaunchCommand({
    agent: input.agent,
    cmdOverrides: { [input.agent]: prefix },
    platform,
    shell,
    sessionOptions: { ...options },
    isRemote: Boolean(input.connectionId)
  })
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  return resolved.command + input.command.slice(prefix.length)
}
