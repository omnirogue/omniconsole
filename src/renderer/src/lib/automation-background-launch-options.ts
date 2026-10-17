import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { automationLaunchAccountEnv } from '../../../shared/automation-launch-preferences'
import { chatBypassLaunchArgs, chatBypassLaunchEnv } from '../../../shared/chat-launch-permissions'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { LaunchAgentBackgroundSessionArgs } from './agent-background-session-contract'

export function automationBackgroundLaunchOptions(
  args: LaunchAgentBackgroundSessionArgs,
  store: AppState,
  worktreeId: string,
  connectionId: string | null | undefined,
  shell: AgentStartupShell = 'posix'
) {
  const target = getActiveRuntimeTarget(getSettingsForWorktreeRuntimeOwner(store, worktreeId))
  const preferences = args.launchPreferences
  return {
    agentArgs: chatBypassLaunchArgs(
      args.agent,
      resolveTuiAgentLaunchArgs(args.agent, store.settings?.agentDefaultArgs),
      shell,
      preferences?.permissionMode
    ),
    agentEnv: chatBypassLaunchEnv(args.agent, {
      ...resolveTuiAgentLaunchEnv(args.agent, store.settings?.agentDefaultEnv),
      ...(target.kind === 'environment'
        ? {}
        : automationLaunchAccountEnv(
            store.settings,
            args.agent,
            preferences,
            Boolean(connectionId)
          ))
    }),
    sessionOptions: preferences
      ? {
          ...(preferences.model ? { model: preferences.model } : {}),
          ...(preferences.effort ? { effort: preferences.effort } : {})
        }
      : undefined,
    sessionOptionsOverrideAgentArgs: Boolean(preferences),
    bypassShellFunctions: Boolean(preferences?.codexAccountId)
  }
}
