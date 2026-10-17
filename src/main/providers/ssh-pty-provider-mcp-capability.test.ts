import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from './ssh-agent-session-create-operation'
import { serializeRemoteRuntimeRpcRequest } from '../../shared/remote-runtime-memory-limits'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { RpcRequest, RpcResponse } from '../runtime/rpc/core'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { AGENT_SESSION_METHODS } from '../runtime/rpc/methods/agent-session'
import { setOmniConsoleMcpSignInResolver } from '../mcp/omni-console-mcp-auth'
import { withOmniConsoleMcpLaunchDefaults } from '../mcp/omni-console-mcp-launch-context'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import {
  HEADER_LENGTH,
  MessageType,
  encodeJsonRpcFrame,
  type JsonRpcRequest,
  type JsonRpcResponse
} from '../ssh/relay-protocol'

const signedIn = vi.fn(() => true)

function createWire(capabilities: () => unknown = () => ({ omniConsoleMcpDefaultVersion: 1 })) {
  const requests: JsonRpcRequest[] = []
  let receive: (data: Buffer) => void = () => {}
  let sequence = 0
  const respond = (response: JsonRpcResponse): void => {
    receive(encodeJsonRpcFrame(response, ++sequence, 0))
  }
  const transport: MultiplexerTransport = {
    write: (data) => {
      if (data[0] !== MessageType.Regular) {
        return
      }
      const request = JSON.parse(
        data.subarray(HEADER_LENGTH, HEADER_LENGTH + data.readUInt32BE(9)).toString()
      ) as JsonRpcRequest
      if (typeof request.id !== 'number') {
        return
      }
      requests.push(request)
      void Promise.resolve()
        .then(() =>
          request.method === 'pty.getCapabilities'
            ? capabilities()
            : { id: 'pty-1', incarnationId: 'incarnation-1' }
        )
        .then(
          (result) => respond({ jsonrpc: '2.0', id: request.id, result }),
          (error: Error) =>
            respond({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: error.message }
            })
        )
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: vi.fn()
  }
  const mux = new SshChannelMultiplexer(transport)
  const provider = new SshPtyProvider('ssh-mcp', mux)
  return {
    requests,
    provider,
    dispose: () => {
      provider.dispose()
      mux.dispose()
    }
  }
}

const options = { cols: 80, rows: 24, cwd: '/remote/work', launchAgent: 'codex' as const }

describe('SSH MCP default capability over the encoded relay wire', () => {
  const wires: ReturnType<typeof createWire>[] = []
  function wire(capabilities?: () => unknown): ReturnType<typeof createWire> {
    const result = createWire(capabilities)
    wires.push(result)
    return result
  }

  beforeEach(() => {
    signedIn.mockReset().mockReturnValue(true)
    setOmniConsoleMcpSignInResolver(signedIn)
  })

  afterEach(() => {
    setOmniConsoleMcpSignInResolver(null)
    for (const fixture of wires.splice(0)) {
      fixture.dispose()
    }
  })

  it('negotiates before sending the serialized downstream hint and selected account', async () => {
    const remote = wire()
    await remote.provider.spawn({ ...options, env: { CODEX_HOME: '/remote/accounts/codex' } })
    expect(remote.requests.map((request) => request.method)).toEqual([
      'pty.getCapabilities',
      'pty.spawn'
    ])
    expect(remote.requests[1].params).toMatchObject({
      omniConsoleMcpDefault: true,
      cwd: '/remote/work',
      launchAgent: 'codex',
      env: { CODEX_HOME: '/remote/accounts/codex' }
    })
    expect(remote.requests[1].params?.env).not.toHaveProperty('OMNI_ACCESS_TOKEN')
    expect(signedIn).toHaveBeenCalledOnce()
  })

  it.each([null, {}, { omniConsoleMcpDefaultVersion: '1' }, { omniConsoleMcpDefaultVersion: 0 }])(
    'refuses a hinted new-client spawn when an old relay advertises %j',
    async (capabilities) => {
      const remote = wire(() => capabilities)
      await expect(remote.provider.spawn(options)).rejects.toThrow(
        'omni_console_mcp_default_unavailable'
      )
      expect(remote.requests.map((request) => request.method)).toEqual(['pty.getCapabilities'])
    }
  )

  it('refuses a malformed capability response without a result when the probe expires', async () => {
    vi.useFakeTimers()
    const remote = wire(() => undefined)
    try {
      const rejected = expect(remote.provider.spawn(options)).rejects.toThrow(
        'omni_console_mcp_default_unavailable'
      )
      await vi.advanceTimersByTimeAsync(SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS)
      await rejected
      expect(remote.requests.map((request) => request.method)).toEqual(['pty.getCapabilities'])
    } finally {
      remote.dispose()
      vi.useRealTimers()
    }
  })

  it('does not send a hinted spawn when the older relay has no capability method', async () => {
    const remote = wire(() => {
      throw new Error('Method not found')
    })
    await expect(remote.provider.spawn(options)).rejects.toThrow(
      'omni_console_mcp_default_unavailable'
    )
    expect(remote.requests.map((request) => request.method)).toEqual(['pty.getCapabilities'])
  })

  it('preserves the legacy wire shape and skips negotiation without an origin hint', async () => {
    signedIn.mockReturnValue(false)
    const remote = wire(() => {
      throw new Error('An older relay must not need a capability method')
    })
    await remote.provider.spawn(options)
    expect(remote.requests.map((request) => request.method)).toEqual(['pty.spawn'])
    expect(remote.requests[0].params).not.toHaveProperty('omniConsoleMcpDefault')
  })

  it.each(['dispatch', 'streaming'] as const)(
    'carries the serialized origin envelope through real %s and agent-session handler into SSH',
    async (dispatchKind) => {
      signedIn.mockReturnValue(false)
      const remote = wire()
      const params = {
        clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        worktree: 'id:remote-workspace',
        agent: 'codex'
      }
      const runtime = {
        getRuntimeId: () => 'headless-host',
        createAgentSession: vi.fn(async (request: RuntimeCreateAgentSessionRequest) => {
          expect(request).toEqual(params)
          await Promise.resolve()
          const spawned = await remote.provider.spawn({
            ...options,
            env: { CODEX_HOME: '/remote/accounts/codex' }
          })
          return {
            terminal: { handle: spawned.id, worktreeId: 'remote-workspace', title: null },
            disposition: 'created'
          }
        })
      }
      const dispatcher = new RpcDispatcher({
        runtime: runtime as unknown as OrcaRuntimeService,
        methods: AGENT_SESSION_METHODS
      })
      const serialized = serializeRemoteRuntimeRpcRequest({
        requestId: 'request-ssh-origin',
        deviceToken: 'authenticated-origin',
        method: 'terminal.createAgentSession',
        params,
        envelope: { omniConsoleMcpDefault: true }
      })
      const request = JSON.parse(serialized) as RpcRequest
      // Socket authentication precedes the decoded request entering the dispatcher.
      request.authToken = 'authenticated-origin'
      const replies: RpcResponse[] = []
      const caller = { clientId: 'desktop-origin', clientKind: 'runtime' as const }
      if (dispatchKind === 'dispatch') {
        replies.push(await dispatcher.dispatch(request, caller))
      } else {
        await dispatcher.dispatchStreaming(
          request,
          (raw) => replies.push(JSON.parse(raw) as RpcResponse),
          caller
        )
      }
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({ ok: true, result: { disposition: 'created' } })
      expect(runtime.createAgentSession).toHaveBeenCalledOnce()
      expect(remote.requests.map((downstream) => downstream.method)).toEqual([
        'pty.getCapabilities',
        'pty.spawn'
      ])
      expect(remote.requests[1].params).toMatchObject({
        omniConsoleMcpDefault: true,
        cwd: '/remote/work',
        launchAgent: 'codex',
        env: { CODEX_HOME: '/remote/accounts/codex' }
      })
    }
  )

  it('isolates concurrent headless clients that request different defaults', async () => {
    signedIn.mockReturnValue(false)
    const admitted = wire()
    const ordinary = wire(() => ({}))
    await Promise.all([
      withOmniConsoleMcpLaunchDefaults(true, async () => {
        await Promise.resolve()
        await admitted.provider.spawn(options)
      }),
      withOmniConsoleMcpLaunchDefaults(false, async () => {
        await Promise.resolve()
        await ordinary.provider.spawn(options)
      })
    ])
    expect(admitted.requests[1].params?.omniConsoleMcpDefault).toBe(true)
    expect(ordinary.requests.map((request) => request.method)).toEqual(['pty.spawn'])
    expect(ordinary.requests[0].params).not.toHaveProperty('omniConsoleMcpDefault')
  })

  it('retains the captured eligibility through an asynchronous capability probe', async () => {
    const remote = wire(() => {
      signedIn.mockReturnValue(false)
      return { omniConsoleMcpDefaultVersion: 1 }
    })
    await remote.provider.spawn(options)
    expect(remote.requests[1].params?.omniConsoleMcpDefault).toBe(true)
    expect(signedIn).toHaveBeenCalledOnce()
  })

  it('retries a negative probe after the relay upgrades on the same connection', async () => {
    const capabilities = vi
      .fn()
      .mockReturnValueOnce({})
      .mockReturnValue({ omniConsoleMcpDefaultVersion: 1 })
    const remote = wire(capabilities)
    await expect(remote.provider.spawn(options)).rejects.toThrow(
      'omni_console_mcp_default_unavailable'
    )
    await remote.provider.spawn(options)
    expect(remote.requests.map((request) => request.method)).toEqual([
      'pty.getCapabilities',
      'pty.getCapabilities',
      'pty.spawn'
    ])
  })

  it('caches successful negotiation within one provider and isolates other relays', async () => {
    const remote = wire()
    await remote.provider.spawn(options)
    await remote.provider.spawn(options)
    expect(
      remote.requests.filter((request) => request.method === 'pty.getCapabilities')
    ).toHaveLength(1)
    const olderRemote = wire(() => ({}))
    await expect(olderRemote.provider.spawn(options)).rejects.toThrow(
      'omni_console_mcp_default_unavailable'
    )
    expect(olderRemote.requests.map((request) => request.method)).toEqual(['pty.getCapabilities'])
  })

  it('cancels one spawn without canceling the shared physical probe or spawning it later', async () => {
    let finishProbe!: (value: unknown) => void
    const probe = new Promise((resolve) => {
      finishProbe = resolve
    })
    const remote = wire(() => probe)
    const controller = new AbortController()
    const canceled = remote.provider.spawn({ ...options, signal: controller.signal })
    const live = remote.provider.spawn(options)
    const rejected = expect(canceled).rejects.toThrow('client_disconnected')
    controller.abort()
    await rejected
    finishProbe({ omniConsoleMcpDefaultVersion: 1 })
    await live
    expect(remote.requests.map((request) => request.method)).toEqual([
      'pty.getCapabilities',
      'pty.spawn'
    ])
  })
})
