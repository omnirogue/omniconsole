import { describe, expect, it, vi } from 'vitest'

import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpJsonRpcConnectionHandlers } from './acp-jsonrpc-connection'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

import { fakeConnection, localLocation } from './acp-test-connection'

describe('AcpStructuredSessionAdapter', () => {
  it('acquires a Grok ACP session and dispatches a user prompt', async () => {
    const items: { body: AgentJournalItemBody }[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => {
        items.push({ body })
      },
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    let handlers: AcpJsonRpcConnectionHandlers = {}
    const connection = fakeConnection({
      onRequest: (method) => {
        if (method === 'session/new') {
          return {
            sessionId: 'grok-sess',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'grok-4.6',
                options: [{ value: 'grok-4.6', name: 'Grok 4.6' }]
              },
              {
                id: 'reasoning_effort',
                category: 'thought_level',
                currentValue: 'high',
                options: [
                  { value: 'high', name: 'High' },
                  { value: 'xhigh', name: 'Extra high' }
                ]
              }
            ]
          }
        }
        if (method === 'session/prompt') {
          handlers.onNotification?.('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello ' }
            }
          })
          handlers.onNotification?.('session/update', {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'from grok' }
            }
          })
          handlers.onNotification?.('session/unknown_vendor', { ping: true })
          return { stopReason: 'end_turn' }
        }
        return {}
      }
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async (_launch, nextHandlers) => {
        handlers = nextHandlers ?? {}
        return connection
      },
      resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
      readProcessStartTime: async () => 1_700_000_000_000
    })
    expect(adapter.supportsCreate?.(localLocation, 'grok')).toBe(true)
    const acquired = await adapter.acquire({
      identity: {
        sessionId: 'omni-session-1',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-1',
      events: sink
    })
    expect(acquired.link.handle).toEqual({ provider: 'grok', sessionId: 'grok-sess' })
    expect(connection.calls.some((call) => call.method === 'authenticate')).toBe(false)
    const dispatched = await adapter.dispatch({
      sessionId: 'omni-session-1',
      clientMessageId: 'msg-1',
      fence: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
    })
    expect(dispatched.state).toBe('accepted')
    expect(
      items.findLast((item) => item.body.kind === 'message' && item.body.role === 'assistant')?.body
    ).toMatchObject({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hello from grok' }]
    })
    const options = await adapter.readOptions({ sessionId: 'omni-session-1', fence: 1 })
    expect(options.current).toMatchObject({ model: 'grok-4.6', effort: 'high' })
    expect(options.models[0]?.efforts.map((effort) => effort.value)).toEqual(['high', 'xhigh'])
    await adapter.setOption({
      sessionId: 'omni-session-1',
      key: 'effort',
      value: 'xhigh',
      fence: 1
    })
    expect(connection.calls.some((call) => call.method === 'session/set_config_option')).toBe(true)
    expect(
      await adapter.readSourceOptions({
        sessionId: 'omni-session-1',
        fence: 1,
        clientMessageId: 'msg-1'
      })
    ).toEqual({ model: 'grok-4.6', effort: 'high' })
    expect(
      await adapter.readSourceOptions({
        sessionId: 'omni-session-1',
        fence: 1,
        clientMessageId: 'later-message'
      })
    ).toBeNull()
    const cancelled = await adapter.cancelTurn({
      sessionId: 'omni-session-1',
      turnId: 'acp-turn-1',
      fence: 1
    })
    expect(cancelled).toEqual({ cancelled: false })
    expect(connection.calls.some((call) => call.method === 'session/cancel')).toBe(false)
  })

  it('loads an existing ACP session when the journal already holds its id', async () => {
    const connection = fakeConnection({
      initialize: { agentCapabilities: { loadSession: true } },
      onRequest: (method) => (method === 'session/load' ? { sessionId: 'grok-sess' } : {})
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
      readProcessStartTime: async () => 1
    })
    const acquired = await adapter.acquire({
      identity: {
        sessionId: 'omni-resume',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'grok-sess' }
      },
      fence: 3,
      spawnToken: 'token-resume'
    })
    expect(connection.calls.map((call) => call.method)).toEqual(['session/load'])
    expect(connection.calls[0]?.params).toMatchObject({
      sessionId: 'grok-sess',
      cwd: '/repo'
    })
    expect(acquired.link).toMatchObject({
      origin: 'resumed',
      handle: { provider: 'grok', sessionId: 'grok-sess' }
    })
  })

  it('opens a new ACP session when the journal handle is still pending', async () => {
    const connection = fakeConnection({
      initialize: { agentCapabilities: { loadSession: true } },
      onRequest: (method) => (method === 'session/new' ? { sessionId: 'grok-fresh' } : {})
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'omni-fresh',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-fresh'
    })
    expect(connection.calls.map((call) => call.method)).toEqual(['session/new'])
  })

  it('restores the full OMP provider/model through ACP before accepting a prompt', async () => {
    const model = 'openrouter/moonshotai/kimi-k2.6'
    const connection = fakeConnection({
      onRequest: (method) =>
        method === 'session/new'
          ? {
              sessionId: 'omp-restored',
              configOptions: [{ id: 'model', category: 'model', currentValue: 'other/default' }]
            }
          : {}
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({ command: 'omp', args: ['acp'], cwd: '/folder' }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'restore-omp',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'omp',
        providerHandle: { kind: 'opaque', agent: 'omp', value: 'pending' }
      },
      fence: 2,
      spawnToken: 'omp-spawn',
      options: { model }
    })
    expect((await adapter.readOptions({ sessionId: 'restore-omp', fence: 2 })).current.model).toBe(
      model
    )
    expect(connection.calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 'omp-restored', configId: 'model', value: model }
    })
    await adapter.closeSession('restore-omp')
  })

  it('restores model and effort and retains a child whose exit is unproven', async () => {
    const connection = fakeConnection({
      onRequest: (method) =>
        method === 'session/new'
          ? {
              sessionId: 'grok-restored',
              configOptions: [
                { id: 'model_id', category: 'model', currentValue: 'grok-default' },
                { id: 'reasoning_effort', category: 'thought_level', currentValue: 'low' }
              ]
            }
          : {}
    })
    const close = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    connection.close = close
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'restore',
        workspaceId: 'folder-workspace',
        hostId: 'local',
        agent: 'grok',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'pending' }
      },
      fence: 2,
      spawnToken: 'spawn-restored',
      options: { model: 'grok-selected', effort: 'high' }
    })
    expect((await adapter.readOptions({ sessionId: 'restore', fence: 2 })).current).toEqual({
      model: 'grok-selected',
      effort: 'high'
    })
    expect(
      await adapter.setOption({ sessionId: 'restore', fence: 2, key: 'effort', value: 'xhigh' })
    ).toMatchObject({ model: 'grok-selected', effort: 'xhigh' })
    expect(await adapter.closeSession('restore')).toBe(false)
    expect(await adapter.closeSession('restore')).toBe(true)
    expect(close).toHaveBeenCalledTimes(2)
  })
})
