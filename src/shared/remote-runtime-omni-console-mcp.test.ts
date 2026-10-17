import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteRuntimeClientError,
  sendRemoteRuntimeRequest,
  sendRemoteRuntimeRequestWithStatusPreflight
} from './remote-runtime-client'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from './remote-runtime-shared-control-test-server'

const capability = 'mcp.omni-console-default.v2'
const envelope = { omniConsoleMcpDefault: true } as const
const launchMethods = [
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.hold',
  'terminal.create',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession'
]

afterEach(closeSharedControlTestServers)

describe('remote OmniConsole MCP launch envelope over E2EE', () => {
  it.each(launchMethods)(
    'new client against capable host negotiates %s on the launch socket',
    async (method) => {
      const server = await createSharedControlTestServer({
        statusResult: { capabilities: [capability] }
      })
      const params = { agent: 'codex', worktree: 'id:worktree-a' }

      await expect(
        sendRemoteRuntimeRequest(server.pairing, method, params, 2000, envelope)
      ).resolves.toMatchObject({ ok: true, result: { method } })

      expect(server.connectionCount()).toBe(1)
      expect(server.auths).toHaveLength(1)
      expect(server.requests).toEqual([
        expect.objectContaining({ method: 'status.get' }),
        expect.objectContaining({ method, params, omniConsoleMcpDefault: true })
      ])
      expect(server.requests[0]).not.toHaveProperty('omniConsoleMcpDefault')
      expect(server.requests[0]?.id).not.toBe(server.requests[1]?.id)
    }
  )

  it.each(launchMethods)(
    'new client against a host without the capability refuses %s before launch',
    async (method) => {
      const server = await createSharedControlTestServer({
        statusResult: { capabilities: ['agent-session.v1'] }
      })
      const request = sendRemoteRuntimeRequest(server.pairing, method, {}, 2000, envelope)

      await expect(request).rejects.toBeInstanceOf(RemoteRuntimeClientError)
      await expect(request).rejects.toMatchObject({ code: 'unsupported_runtime_capability' })
      expect(server.connectionCount()).toBe(1)
      expect(server.requests).toEqual([expect.objectContaining({ method: 'status.get' })])
    }
  )

  it('refuses an older status response that omits capabilities', async () => {
    const server = await createSharedControlTestServer({ statusResult: { graphStatus: 'ok' } })

    await expect(
      sendRemoteRuntimeRequest(server.pairing, 'terminal.create', {}, 2000, envelope)
    ).rejects.toMatchObject({ code: 'unsupported_runtime_capability' })

    expect(server.requests).toEqual([expect.objectContaining({ method: 'status.get' })])
  })

  it('refuses a v1 host that cannot configure Gemini or Grok', async () => {
    const server = await createSharedControlTestServer({
      statusResult: { capabilities: ['mcp.omni-console-default.v1'] }
    })
    await expect(
      sendRemoteRuntimeRequest(
        server.pairing,
        'terminal.create',
        { agent: 'gemini' },
        2000,
        envelope
      )
    ).rejects.toMatchObject({ code: 'unsupported_runtime_capability' })
    expect(server.requests).toEqual([expect.objectContaining({ method: 'status.get' })])
  })

  it('holds launch until the same socket receives the capability response', async () => {
    const server = await createSharedControlTestServer({
      statusResult: { capabilities: [capability] },
      delayedMethods: ['status.get']
    })
    const request = sendRemoteRuntimeRequest(server.pairing, 'terminal.create', {}, 2000, envelope)

    await vi.waitFor(() => expect(server.requests).toHaveLength(1))
    expect(server.requests[0]?.method).toBe('status.get')
    server.flushDelayedResponses()
    await expect(request).resolves.toMatchObject({ ok: true })

    expect(server.connectionCount()).toBe(1)
    expect(server.requests.map((request) => request.method)).toEqual([
      'status.get',
      'terminal.create'
    ])
  })

  it('keeps the legacy launch path when the client does not request the MCP default', async () => {
    const server = await createSharedControlTestServer()

    await expect(
      sendRemoteRuntimeRequest(server.pairing, 'terminal.create', {}, 2000)
    ).resolves.toMatchObject({ ok: true })

    expect(server.requests).toEqual([expect.objectContaining({ method: 'terminal.create' })])
    expect(server.requests[0]).not.toHaveProperty('omniConsoleMcpDefault')
  })

  it('retains the caller status validator and does not launch when it rejects', async () => {
    const server = await createSharedControlTestServer({
      statusResult: { capabilities: [capability] }
    })
    const rejection = new Error('Host is not admitted for this card')
    const validateStatus = vi.fn(() => {
      throw rejection
    })

    await expect(
      sendRemoteRuntimeRequestWithStatusPreflight(
        server.pairing,
        'terminal.create',
        {},
        2000,
        validateStatus,
        envelope
      )
    ).rejects.toBe(rejection)

    expect(validateStatus).toHaveBeenCalledOnce()
    expect(server.requests).toEqual([expect.objectContaining({ method: 'status.get' })])
  })

  it('rejects an MCP default hint on a method that cannot launch an agent', async () => {
    const server = await createSharedControlTestServer({
      statusResult: { capabilities: [capability] }
    })

    await expect(
      sendRemoteRuntimeRequest(server.pairing, 'terminal.send', {}, 2000, envelope)
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(server.requests).toEqual([])
  })
})
