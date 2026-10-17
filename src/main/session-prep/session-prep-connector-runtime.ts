import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { TuiAgent } from '../../shared/tui-agent'
import { readManagedSessionToolsFiles } from '../runtime/managed-session-tools-files'
import { SessionPrepHostError } from './session-prep-execution-host'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepRuntime } from './session-prep-runtime-host'
import type { SessionPrepLaunchedSurface } from './session-prep-folders'

export function sessionPrepConnectorRequest(
  runtime: SessionPrepRuntime,
  launch: SessionPrepConnectorLaunch | undefined,
  agent: TuiAgent
): Partial<RuntimeCreateAgentSessionRequest> {
  if (!launch) {
    return {}
  }
  readManagedSessionToolsFiles(launch.managedToolsFile, {
    nativeOperationId: launch.nativeOperationId,
    provider: agent
  }).assertCurrent()
  const runtimeId = runtime.getStatus?.().runtimeId
  if (!runtimeId || (launch.controllerRuntimeId && launch.controllerRuntimeId !== runtimeId)) {
    throw new SessionPrepHostError('The connector launch runtime identity could not be verified.')
  }
  return {
    clientOperationId: launch.nativeOperationId,
    managedToolsFile: launch.managedToolsFile,
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: 'local',
      expectedRuntimeId: runtimeId
    }
  }
}

export async function createSessionPrepConnectorWorktree(
  runtime: SessionPrepRuntime,
  host: SessionPrepHost,
  args: Parameters<SessionPrepHost['createWorktreeWithAgent']>[0]
): ReturnType<SessionPrepHost['createWorktreeWithAgent']> {
  sessionPrepConnectorRequest(runtime, args.connectorLaunch, args.agent)
  const created = await runtime.createManagedWorktree({
    repoSelector: `id:${args.repoId}`,
    name: args.name,
    activate: false
  })
  const surface = await host.createAgentSessionIn({
    ...args,
    worktreeId: created.worktree.id,
    expectedWorkspace: undefined,
    clientOperationId: args.connectorLaunch!.nativeOperationId
  })
  return {
    worktreeId: created.worktree.id,
    ...(surface ? { surface } : {}),
    ...(surface?.nativeReceipt?.terminal.handle
      ? { paneHandle: surface.nativeReceipt.terminal.handle }
      : {})
  }
}

export function sessionPrepLaunchSurface(
  created: Awaited<ReturnType<SessionPrepRuntime['createAgentSession']>>,
  launch: SessionPrepConnectorLaunch | undefined,
  agent: TuiAgent
): SessionPrepLaunchedSurface {
  const terminal = created.terminal
  if (!terminal || (launch && !terminal.handle)) {
    throw new SessionPrepHostError(
      'Agent startup receipt is unverified. Inspect the workspace before retrying.'
    )
  }
  return {
    tabId: terminal.tabId,
    paneKey: terminal.paneKey,
    ...(launch && terminal.handle
      ? {
          nativeReceipt: {
            ...created,
            terminal: { ...terminal, handle: terminal.handle },
            operationId: launch.nativeOperationId,
            provider: agent
          }
        }
      : {})
  }
}
