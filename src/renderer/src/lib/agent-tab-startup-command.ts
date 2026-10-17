import type { TerminalState } from '@/store/terminals/terminal-state'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab-types'
import { tuiAgentToAgentKind } from '@/lib/telemetry'

export function buildAgentTabStartupCommand(
  {
    agent,
    agentArgs,
    launchSource,
    launchTrigger
  }: Pick<LaunchAgentInNewTabArgs, 'agent' | 'agentArgs' | 'launchSource' | 'launchTrigger'>,
  startupPlan: AgentStartupPlan,
  prompt: string,
  promptDelivery: NonNullable<LaunchAgentInNewTabArgs['promptDelivery']>
): TerminalState['pendingStartupByTabId'][string] {
  return {
    command: startupPlan.launchCommand,
    ...(launchTrigger ? { launchTrigger } : {}),
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(agentArgs !== undefined ? { agentArgsOverride: agentArgs } : {}),
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    ...(agent === 'command-code' && prompt.length > 0 && promptDelivery === 'auto-submit'
      ? { initialAgentStatus: { agent, prompt } }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  }
}
