import { isResumableTuiAgent, type AgentProviderSessionMetadata } from './agent-session-resume'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import type { AgentStartupPlan } from './tui-agent-startup'
import {
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'

export type AgentBackgroundResumeRequest = {
  providerSession: AgentProviderSessionMetadata
}

/**
 * Turns a fresh background launch plan into a resume of `providerSession` that still
 * delivers the prompt: `codex … resume <id> '<prompt>'`, `claude … --resume <id> '<prompt>'`.
 *
 * Why it derives from the fresh plan rather than rebuilding from settings: the fresh
 * plan already resolved the command override, the bypass args and any per-launch
 * model/effort/account inputs; the resume must carry exactly those. launchConfig
 * strips the session options on purpose (a relaunched sleeping session keeps only
 * explicit user args), so the resume takes the command that still has them.
 * Returns the fresh plan untouched when the agent has no resume argv or the prompt
 * cannot ride on argv — the caller then starts a fresh thread as before.
 */
export function applyAgentBackgroundResumePlan(
  resume: AgentBackgroundResumeRequest | undefined,
  fresh: AgentStartupPlan | null,
  launch: { platform: NodeJS.Platform; shell?: AgentStartupShell; prompt: string }
): AgentStartupPlan | null {
  if (!resume || !fresh || !isResumableTuiAgent(fresh.agent)) {
    return fresh
  }
  const config = TUI_AGENT_CONFIG[fresh.agent]
  const prompt = launch.prompt.trim()
  if (prompt && config.promptInjectionMode !== 'argv') {
    return fresh
  }
  const shell = resolveStartupShell(launch.platform, launch.shell)
  const resumed = buildAgentResumeStartupPlan({
    agent: fresh.agent,
    providerSession: resume.providerSession,
    cmdOverrides: {},
    agentCommand: fresh.agentCommandWithSessionOptions ?? fresh.launchConfig.agentCommand,
    agentArgs: fresh.launchConfig.agentArgs,
    agentEnv: fresh.launchConfig.agentEnv,
    ...(fresh.launchConfig.ompResumeFilePath
      ? { ompResumeFilePath: fresh.launchConfig.ompResumeFilePath }
      : {}),
    platform: launch.platform,
    shell
  })
  if (!resumed) {
    return fresh
  }
  // Why: the sleeping-session relaunch config keeps the fresh plan's stripped command.
  const withFreshConfig = { ...resumed, launchConfig: fresh.launchConfig }
  if (!prompt) {
    return withFreshConfig
  }
  const separator = config.argvPromptSeparator ? ` ${config.argvPromptSeparator}` : ''
  return {
    ...withFreshConfig,
    launchCommand: `${resumed.launchCommand}${separator} ${quoteStartupArg(`${config.argvPromptPrefix ?? ''}${prompt}`, shell)}`
  }
}
