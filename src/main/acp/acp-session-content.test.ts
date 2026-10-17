import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpJsonRpcConnectionHandlers } from './acp-jsonrpc-connection'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

import { fakeConnection } from './acp-test-connection'

describe('AcpStructuredSessionAdapter', () => {
  it('answers a permission that arrived before the session was registered', async () => {
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
      initialize: { authMethods: [{ id: 'cursor_login' }] },
      onRequest: (method) => {
        if (method === 'authenticate') {
          handlers.onServerRequest?.({
            id: 3,
            method: 'session/request_permission',
            params: {
              toolCall: { title: 'Early', toolCallId: 'early-perm' },
              options: [{ optionId: 'allow-once', name: 'Allow once' }]
            }
          })
          return {}
        }
        if (method === 'session/new') {
          return { sessionId: 'cursor-sess' }
        }
        return {}
      }
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async (_launch, nextHandlers) => {
        handlers = nextHandlers ?? {}
        return connection
      },
      resolveLaunch: async () => ({ command: 'agent', args: ['acp'], cwd: '/repo' }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'omni-cursor-early',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'cursor',
        providerHandle: { kind: 'opaque', agent: 'cursor', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-early',
      events: sink
    })
    expect(items.some((item) => item.body.kind === 'approval')).toBe(true)
    await adapter.answerPrompt({
      sessionId: 'omni-cursor-early',
      itemId: 'perm-number-3',
      kind: 'approval',
      optionId: 'allow-once',
      fence: 1
    })
    expect(connection.replies).toEqual([
      { id: 3, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }
    ])
  })

  it('rejects an image prompt when the agent did not advertise image capability', async () => {
    const connection = fakeConnection({
      onRequest: (method) => (method === 'session/new' ? { sessionId: 'claude-sess' } : {})
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({
        command: 'npx',
        args: ['-y', '@agentclientprotocol/claude-agent-acp@0.74.0'],
        cwd: '/repo'
      }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'omni-claude',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-3'
    })
    const dispatched = await adapter.dispatch({
      sessionId: 'omni-claude',
      clientMessageId: 'msg-img',
      fence: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path: '/tmp/shot.png' }]
      }
    })
    expect(dispatched).toMatchObject({
      state: 'rejected',
      reason: 'ACP session does not accept images'
    })
  })

  it('sends image content to an image-capable ACP agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-acp-image-'))
    const path = join(dir, 'shot.png')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    await writeFile(path, png)
    const connection = fakeConnection({
      initialize: { agentCapabilities: { promptCapabilities: { image: true } } },
      onRequest: (method) => (method === 'session/new' ? { sessionId: 'grok-sess' } : {})
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({ command: 'grok', args: ['agent', 'stdio'], cwd: '/repo' }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'omni-image',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: { kind: 'opaque', agent: 'grok', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-image'
    })
    const dispatched = await adapter.dispatch({
      sessionId: 'omni-image',
      clientMessageId: 'msg-img',
      fence: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path }]
      }
    })
    expect(dispatched.state).toBe('accepted')
    expect(connection.calls.find((call) => call.method === 'session/prompt')?.params).toMatchObject(
      {
        prompt: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]
      }
    )
  })
})
