import { chatBypassLaunchTokens } from '../../../shared/chat-launch-permissions'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { HUB_TASK_ID_PATTERN } from '../../../shared/omnios-task-binding'

type LaunchEnvResolver = (
  provider: AgentSessionRecord['provider']
) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined

type LaunchArgsResolver = (
  provider: AgentSessionRecord['provider']
) => Promise<string[] | undefined> | string[] | undefined

export async function pinnedAgentSessionHubTaskId(
  resolver: ((workspaceId: string) => Promise<string | undefined> | string | undefined) | undefined,
  params: AgentSessionAttachParams,
  existing: AgentSessionRecord | null
): Promise<{ hubTaskId: string } | Record<string, never>> {
  if (existing) {
    return existing.hubTaskId ? { hubTaskId: existing.hubTaskId } : {}
  }
  if (
    params.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    params.location.wslDistro !== null
  ) {
    return {}
  }
  const hubTaskId = await resolver?.(params.location.workspaceId)
  if (hubTaskId === undefined) {
    return {}
  }
  if (!HUB_TASK_ID_PATTERN.test(hubTaskId)) {
    throw new Error('agent_session_hub_task_invalid')
  }
  return { hubTaskId }
}

export async function pinnedAgentSessionLaunchEnv(
  resolver: LaunchEnvResolver | undefined,
  params: AgentSessionAttachParams
): Promise<{ launchEnv: Record<string, string> } | Record<string, never>> {
  if (!resolver) {
    return {}
  }
  return {
    launchEnv: {
      ...(await resolver(params.provider)),
      [params.accountHome.variable]: params.accountHome.path
    }
  }
}

export async function pinnedAgentSessionLaunchArgs(
  resolver: LaunchArgsResolver | undefined,
  params: AgentSessionAttachParams
): Promise<{ launchArgs: string[] } | Record<string, never>> {
  const launchArgs = params.launchArgs ?? (await resolver?.(params.provider))
  if (params.options?.chatPermissionMode === 'bypass' && params.provider === 'codex') {
    return { launchArgs: chatBypassLaunchTokens('codex', launchArgs ?? []) }
  }
  return launchArgs ? { launchArgs: [...launchArgs] } : {}
}
