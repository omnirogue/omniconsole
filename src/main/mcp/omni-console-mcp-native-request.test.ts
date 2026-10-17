import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CodexAppServerConnection } from '../codex/codex-app-server-connection'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { serializeRemoteRuntimeRpcRequest } from '../../shared/remote-runtime-memory-limits'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session-wire'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { RpcRequest, RpcResponse } from '../runtime/rpc/core'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { loadAgentSessionStore } from '../runtime/agent-session-record-store-file'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../runtime/rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from '../runtime/structured-agent-session-runtime'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { setOmniConsoleMcpSignInResolver } from './omni-console-mcp-auth'
import { OMNI_CONSOLE_MCP_URL } from '../../shared/mcp-config'

const SESSION = 'session-mcp-native'
const CLIENT = {
  clientId: 'desktop-origin',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}
let root: string
let accountHome: string
let dispatcher: RpcDispatcher
let launches: { config: string | undefined; cwd?: string; home?: string }[]
let operation = 0

function envelope(method: string, fields: Record<string, unknown>, fence: number | null) {
  return {
    sessionId: SESSION,
    clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function identity() {
  return {
    location: {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: 'workspace-mcp',
      workspaceKind: 'folder' as const
    },
    provider: 'codex' as const,
    agent: 'codex' as const,
    accountHome: { variable: 'CODEX_HOME' as const, path: accountHome },
    runtimeKind: 'native' as const
  }
}

function createParams() {
  const fields = { worktree: 'id:workspace-mcp', agent: 'codex' }
  return { ...fields, envelope: envelope('agentSession.create', fields, null) }
}

async function dispatchOnce(
  method: string,
  params: unknown,
  hint?: true,
  stream = true
): Promise<RpcResponse> {
  const serialized = serializeRemoteRuntimeRpcRequest({
    requestId: `request-${++operation}`,
    deviceToken: 'authenticated-device',
    method,
    params,
    ...(hint ? { envelope: { omniConsoleMcpDefault: hint } } : {})
  })
  const request = JSON.parse(serialized) as RpcRequest
  // Authentication belongs to the socket adapter; this tests its decoded request with real dispatch.
  request.authToken = 'authenticated-device'
  expect(request.params).toEqual(params)
  if (!stream) {
    return dispatcher.dispatch(request, CLIENT)
  }
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), CLIENT)
  expect(replies).toHaveLength(1)
  return replies[0]!
}

async function call(method: string, params: unknown, hint?: true, stream = true) {
  const response = await dispatchOnce(method, params, hint, stream)
  expect(response.ok, JSON.stringify(response)).toBe(true)
  return response
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-mcp-native-wire-'))
  accountHome = join(root, 'pinned-account')
  await mkdir(join(root, 'workspace'), { recursive: true })
  await mkdir(join(accountHome, 'sessions'), { recursive: true })
  launches = []
  setOmniConsoleMcpSignInResolver(null)
  const runtime = {
    getRuntimeId: () => 'headless-runtime',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async (input: {
      envelope: AgentSessionMutationEnvelope
    }) => ({
      ...identity(),
      envelope: input.envelope
    }),
    publishStructuredAgentSessionTab: () => {},
    registerSubscriptionCleanup: () => {},
    cleanupSubscription: () => {},
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost({
        stateDirectory: join(root, 'state'),
        hostId: 'local',
        claimKeyId: 'key-mcp',
        resolveWorkspacePath: async () => join(root, 'workspace'),
        resolveCodexCommand: () => 'scripted-codex',
        resolveEnvironment: async () => ({
          HOME: join(root, 'host-home'),
          CODEX_HOME: join(root, 'wrong-account')
        }),
        readProcessStartTime: async () => 1_700_000_000_000,
        reapOrphanChildren: async () => [],
        openCodexConnection: async (launch) => {
          const path = join(launch.env!.CODEX_HOME, 'config.toml')
          launches.push({
            config: existsSync(path) ? readFileSync(path, 'utf8') : undefined,
            cwd: launch.cwd,
            home: launch.env?.CODEX_HOME
          })
          let closed = false
          const connection: CodexAppServerConnection = {
            pid: 4321 + launches.length,
            get closed() {
              return closed
            },
            request: async (method) =>
              method === 'thread/start' || method === 'thread/resume'
                ? { thread: { id: 'thread-mcp-native' } }
                : method === 'model/list'
                  ? {
                      data: [
                        {
                          model: 'scripted-model',
                          displayName: 'Scripted model',
                          supportedReasoningEfforts: [],
                          isDefault: true
                        }
                      ],
                      nextCursor: null
                    }
                  : {},
            notify: () => {},
            respond: () => {},
            respondWithError: () => {},
            close: async () => {
              closed = true
              return true
            }
          }
          return connection
        }
      }).then(() => undefined)
  }
  dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  setOmniConsoleMcpSignInResolver(null)
  await rm(root, { recursive: true, force: true })
})

describe('serialized desktop defaults on a headless structured host', () => {
  it.each([false, 'true', { url: 'https://other.example/mcp' }])(
    'rejects malformed eligibility %j before installing a host or spawning',
    async (hint) => {
      const request = JSON.parse(
        JSON.stringify({
          id: 'invalid-hint',
          authToken: 'paired',
          method: 'agentSession.create',
          params: createParams(),
          omniConsoleMcpDefault: hint
        })
      ) as RpcRequest
      expect(await dispatcher.dispatch(request, CLIENT)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
      expect(launches).toHaveLength(0)
      expect(existsSync(join(root, 'state'))).toBe(false)
    }
  )

  it('retains strict session params and refuses hints on methods that cannot launch', async () => {
    for (const [method, params] of [
      ['agentSession.create', { ...createParams(), unsupportedLaunchOverride: true }],
      ['agentSession.options', { sessionId: SESSION }]
    ] as const) {
      const request: RpcRequest = {
        id: 'invalid-request',
        authToken: 'paired',
        method,
        params,
        omniConsoleMcpDefault: true
      }
      expect(await dispatcher.dispatch(request, CLIENT)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(launches).toHaveLength(0)
    expect(existsSync(join(root, 'state'))).toBe(false)
  })

  it.each([true, false])(
    'prepares the actual pinned account before create (stream=%s) and replays the same operation',
    async (stream) => {
      const params = createParams()
      expect(await call('agentSession.create', params, true, stream)).toMatchObject({
        ok: true,
        result: { ok: true }
      })
      expect(launches).toHaveLength(1)
      expect(launches[0]).toMatchObject({ home: accountHome, cwd: join(root, 'workspace') })
      expect(launches[0].config).toContain(OMNI_CONSOLE_MCP_URL)
      expect(existsSync(join(root, 'wrong-account', 'config.toml'))).toBe(false)
      expect(await call('agentSession.create', params, undefined, stream)).toMatchObject({
        ok: true,
        result: { ok: true, replayed: true }
      })
      expect(launches).toHaveLength(1)
      expect(
        await readFile(join(root, 'state', 'agent-sessions', 'agent-sessions.json'), 'utf8')
      ).not.toContain('omniConsoleMcpDefault')
    }
  )

  it('prepares missing config on a real hold revival after a prior unhinted create', async () => {
    expect(await call('agentSession.create', createParams())).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(launches[0].config).toBeUndefined()
    expect(await call('agentSession.close', { sessionId: SESSION })).toMatchObject({ ok: true })
    expect(
      await call('agentSession.hold', { sessionId: SESSION, holderId: 'native-pane' }, true)
    ).toMatchObject({ ok: true, result: { held: true } })
    expect(launches).toHaveLength(2)
    expect(launches[1].config).toContain(OMNI_CONSOLE_MCP_URL)
  })

  it('preserves an explicit disabled custom server and refuses the reacquiring launch', async () => {
    expect(await call('agentSession.create', createParams())).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    await call('agentSession.close', { sessionId: SESSION })
    await mkdir(accountHome, { recursive: true })
    const disabled =
      'mcp_servers."omni-console" = { url = "https://custom.example/mcp", enabled = false }\n'
    await writeFile(join(accountHome, 'config.toml'), disabled)
    const stored = await loadAgentSessionStore(
      join(root, 'state', 'agent-sessions', 'agent-sessions.json'),
      'local'
    )
    const currentFence = stored.state.records.get(SESSION)!.lease.runtimeFence
    const params = {
      ...identity(),
      providerHandle: { kind: 'codex' as const, threadId: 'thread-mcp-native' },
      envelope: envelope('agentSession.attach', {}, currentFence)
    }
    params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId: SESSION,
      fields: attachFingerprintFields(params)
    })
    const ensured = await dispatchOnce('agentSession.ensure', params, true)
    // Why: a connector the operator explicitly blocked must not be silently rewritten,
    // and the agent must not start as though its omni-console endpoint were available.
    expect(ensured, JSON.stringify(ensured)).toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: expect.stringContaining('disabled or overridden') }
    })
    expect(await readFile(join(accountHome, 'config.toml'), 'utf8')).toBe(disabled)
    expect(launches).toHaveLength(1)
  })
})
