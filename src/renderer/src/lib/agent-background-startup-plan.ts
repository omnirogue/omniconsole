import { automationBackgroundLaunchOptions } from './automation-background-launch-options'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { requireTuiAgentConfig } from '../../../shared/require-tui-agent-config'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { applyAgentBackgroundResumePlan } from '../../../shared/agent-resume-prompt-launch-plan'
import type { AppState } from '@/store/types'
import type { LaunchAgentBackgroundSessionArgs } from './agent-background-session-contract'
import type { AgentBackgroundLaunchHost } from './agent-background-session-launch-host'

export function buildAgentBackgroundStartupPlan(
  args: LaunchAgentBackgroundSessionArgs,
  store: AppState,
  launchHost: AgentBackgroundLaunchHost
) {
  const { agent, worktreeId } = args
  const { platform: launchPlatform, isRemote } = launchHost
  const startupShell = resolveLocalWindowsAgentStartupShell({
    platform: launchPlatform,
    isRemote,
    terminalWindowsShell: store.settings?.terminalWindowsShell
  })
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = requireTuiAgentConfig(agent).promptInjectionMode === 'stdin-after-start'

  const pasteDraftAfterLaunch = hasPrompt && isFollowupPath ? trimmedPrompt : null
  const freshStartupPlan = buildAgentStartupPlan({
    agent,
    prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : '',
    cmdOverrides: store.settings?.agentCmdOverrides ?? {},
    ...automationBackgroundLaunchOptions(
      args,
      store,
      worktreeId,
      launchHost.connectionId,
      startupShell ?? 'posix'
    ),
    platform: launchPlatform,
    shell: startupShell,
    isRemote,
    allowEmptyPromptLaunch: !hasPrompt || isFollowupPath
  })
  const startupPlan = applyAgentBackgroundResumePlan(args.resume, freshStartupPlan, {
    platform: launchPlatform,
    shell: startupShell,
    prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : ''
  })
  return { startupPlan, hasPrompt, isFollowupPath, trimmedPrompt, pasteDraftAfterLaunch }
}
