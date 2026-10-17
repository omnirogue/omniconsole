import type { AutomationDefinitionContext } from './automation-definition-context'
import type { AutomationLaunchPreferences } from './automation-launch-preferences'
import { chatBypassLaunchArgs } from './chat-launch-permissions'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export function routineLaunchPreferences(
  automation: AutomationDefinitionContext & { launchPreferences?: AutomationLaunchPreferences }
): AutomationLaunchPreferences | undefined {
  return automation.tools
    ? {
        ...automation.launchPreferences,
        permissionMode: automation.tools.allowWrite ? 'yolo' : 'read-only'
      }
    : automation.launchPreferences
}
export function routineLaunchArgs(
  agent: TuiAgent,
  args: string,
  preferences?: AutomationLaunchPreferences,
  shell: AgentStartupShell = 'posix'
): string {
  return preferences?.permissionMode
    ? chatBypassLaunchArgs(agent, args, shell, preferences.permissionMode)
    : args
}
