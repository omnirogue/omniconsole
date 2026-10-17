import { randomUUID } from 'node:crypto'
import { acpSpawnRecipe } from '../../shared/acp-agent-recipes'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter'
import type { AcpJsonRpcConnection, openAcpJsonRpcConnection } from './acp-jsonrpc-connection'
import { createAcpSessionHandlers, type AcpSession } from './acp-session-notifications'
import {
  acpProviderHandle,
  acpResumeSessionId,
  authenticateAcpConnection
} from './acp-session-identity'
import { indexAcpSessionConfiguration, type AcpSessionConfiguration } from './acp-session-models'
import type { AcpPendingPrompt } from './acp-session-events'

export async function acquireAcpSession(
  context: {
    deps: AcpStructuredSessionAdapterDeps
    sessions: Map<string, AcpSession>
    connections: Map<string, AcpJsonRpcConnection>
    openConnection: typeof openAcpJsonRpcConnection
    setOption: StructuredAgentSessionAdapter['setOption']
  },
  input: StructuredAgentSessionAcquireInput
): Promise<AgentSessionAcquisition> {
  const agent = input.identity.agent
  if (!acpSpawnRecipe(agent) || context.deps.enabled?.(agent) === false) {
    throw new Error(`ACP Chat UI does not support ${agent}`)
  }
  const launch = await context.deps.resolveLaunch({
    identity: input.identity,
    spawnToken: input.spawnToken
  })
  const pendingPermissions = new Map<string, AcpPendingPrompt>()
  const live: { connection?: AcpJsonRpcConnection } = {}
  const connection = await context.openConnection(
    launch,
    createAcpSessionHandlers({
      input,
      live,
      pendingPermissions,
      getSession: () => context.sessions.get(input.identity.sessionId)
    })
  )
  live.connection = connection
  context.connections.set(input.identity.sessionId, connection)
  const pid = connection.pid
  if (pid === undefined) {
    await connection.close()
    throw new Error('ACP child started without a pid')
  }
  const processStartTimeMs = await context.deps.readProcessStartTime(pid)
  if (processStartTimeMs === null) {
    await connection.close()
    throw new Error(`ACP child start time for pid ${pid} could not be read`)
  }
  await authenticateAcpConnection(agent, connection)
  const cwd = launch.cwd
  if (!cwd) {
    await connection.close()
    throw new Error('ACP session cwd is required')
  }
  const loadedId = acpResumeSessionId(input.identity)
  if (loadedId && !connection.initialize.agentCapabilities?.loadSession) {
    throw new Error('This ACP agent cannot load the saved session; history is kept')
  }
  const useLoad = Boolean(loadedId)
  const created = (await connection.request(
    useLoad ? 'session/load' : 'session/new',
    useLoad ? { sessionId: loadedId, cwd, mcpServers: [] } : { cwd, mcpServers: [] }
  )) as AcpSessionConfiguration & { sessionId?: string }
  if (loadedId && created.sessionId && created.sessionId !== loadedId) {
    throw new Error('ACP load returned a different session identity')
  }
  const acpSessionId = created.sessionId ?? loadedId
  if (!acpSessionId) {
    await connection.close()
    throw new Error('ACP session/new did not return a session id')
  }
  const config = indexAcpSessionConfiguration(created)
  context.sessions.set(input.identity.sessionId, {
    connection,
    acpSessionId,
    agent,
    fence: input.fence,
    events: input.events,
    bypass: input.options?.chatPermissionMode === 'bypass',
    options: { ...input.options },
    activeTurnId: null,
    tools: new Map(),
    imageCapable: connection.initialize.agentCapabilities?.promptCapabilities?.image === true,
    config,
    pendingPermissions,
    promptCount: 0,
    assistant: { text: '' }
  })
  for (const key of ['model', 'effort'] as const) {
    const value = input.options?.[key]
    if (
      value &&
      value !== context.sessions.get(input.identity.sessionId)?.config.result.current[key]
    ) {
      await context.setOption({
        sessionId: input.identity.sessionId,
        fence: input.fence,
        key,
        value
      })
    }
  }
  const observedAt = context.deps.now?.() ?? Date.now()
  return {
    process: {
      hostId: input.identity.hostId,
      pid,
      processStartTimeMs,
      spawnToken: input.spawnToken
    },
    link: {
      linkId: `acp-${input.fence}-${randomUUID()}`,
      handle: acpProviderHandle(agent, acpSessionId),
      origin: useLoad ? 'resumed' : 'created',
      mintedAtFence: input.fence,
      observedAt
    }
  }
}
