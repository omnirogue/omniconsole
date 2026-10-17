import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  acpAccountHomeVariable,
  acpHandleProvider,
  type AcpStructuredAgent
} from '../../shared/acp-agent-recipes'
import { isAcpEnabled, type AcpLaunchSupport } from '../../shared/acp-launch-support'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  findFirstExecutable,
  getExecutableNames,
  splitPath
} from '../../shared/node-cli-command-resolution'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { probeAcpLaunch } from './acp-launch-probe'

export function acpLocationSupport(location: AgentSessionExecutionLocation): AcpLaunchSupport {
  if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { supported: false, reason: 'remote' }
  }
  if (location.wslDistro) {
    return { supported: false, reason: 'wsl' }
  }
  if (process.platform === 'win32') {
    return { supported: false, reason: 'windows' }
  }
  return { supported: true }
}

export async function getAcpCreateSupport(input: {
  agent: AcpStructuredAgent
  settings: GlobalSettings
  location: AgentSessionExecutionLocation
  cwd: string
}): Promise<AcpLaunchSupport & { transport?: 'acp' }> {
  if (!isAcpEnabled(input.settings, input.agent)) {
    return { supported: false, reason: 'disabled' }
  }
  const support = acpLocationSupport(input.location)
  if (!support.supported) {
    return support
  }
  if (input.settings.agentCmdOverrides?.[input.agent]?.trim()) {
    return { supported: false, reason: 'custom-launch' }
  }
  const env = {
    ...(await resolveLoginShellEnvironment()),
    ...resolveTuiAgentLaunchEnv(input.agent, input.settings.agentDefaultEnv)
  }
  const result = await probeAcpLaunch({
    agent: input.agent,
    cwd: input.cwd,
    env: env as Record<string, string>,
    findCommand: (command) =>
      findFirstExecutable(
        process.platform,
        splitPath(env.PATH),
        getExecutableNames(process.platform, command)
      )
  })
  return result.supported ? { supported: true, transport: 'acp' } : result
}

export async function resolveAcpCreateIntent(input: {
  envelope: { sessionId: string; clientOperationId: string }
  agent: AcpStructuredAgent
  options?: Readonly<Record<string, string>>
  settings: GlobalSettings
  location: AgentSessionExecutionLocation
}): Promise<AgentSessionAttachParams> {
  if (!isAcpEnabled(input.settings, input.agent) || !acpLocationSupport(input.location).supported) {
    throw new Error('ACP is disabled for this agent or execution host')
  }
  const provider = acpHandleProvider(input.agent)
  const variable = acpAccountHomeVariable(input.agent)
  if (!provider || !variable) {
    throw new Error('Unsupported ACP provider')
  }
  const env = {
    ...(await resolveLoginShellEnvironment()),
    ...resolveTuiAgentLaunchEnv(input.agent, input.settings.agentDefaultEnv)
  }
  const defaultHome =
    variable === 'HOME'
      ? homedir()
      : join(homedir(), provider === 'cursor' ? '.cursor' : `.${provider}`)
  return {
    envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' },
    location: input.location,
    provider,
    agent: input.agent,
    accountHome: { variable, path: env[variable]?.trim() || defaultHome },
    runtimeKind: 'native',
    options: { ...input.options, transport: 'acp', acpAgent: input.agent }
  }
}
