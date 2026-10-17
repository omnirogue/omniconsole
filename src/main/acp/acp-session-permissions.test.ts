import { describe, expect, it } from 'vitest'

import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { AcpJsonRpcConnectionHandlers } from './acp-jsonrpc-connection'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

import { fakeConnection } from './acp-test-connection'

describe('AcpStructuredSessionAdapter', () => {
  it('authenticates Cursor with cursor_login and answers a permission card', async () => {
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
        if (method === 'session/new') {
          return {
            sessionId: 'cursor-sess',
            configOptions: [
              {
                id: 'mode',
                category: 'mode',
                currentValue: 'agent',
                options: [
                  { value: 'agent', name: 'Agent' },
                  { value: 'plan', name: 'Plan' },
                  { value: 'ask', name: 'Ask' }
                ]
              }
            ]
          }
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
      readProcessStartTime: async () => 1_700_000_000_000
    })
    await adapter.acquire({
      identity: {
        sessionId: 'omni-cursor',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'cursor',
        providerHandle: { kind: 'opaque', agent: 'cursor', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-2',
      events: sink
    })
    expect(connection.calls[0]).toMatchObject({
      method: 'authenticate',
      params: { methodId: 'cursor_login' }
    })
    handlers.onServerRequest?.({
      id: 7,
      method: 'session/request_permission',
      params: {
        toolCall: { title: 'Read file', toolCallId: 'tool-1' },
        options: [{ optionId: 'allow-once', name: 'Allow once' }]
      }
    })
    expect(items.some((item) => item.body.kind === 'approval')).toBe(true)
    await adapter.answerPrompt({
      sessionId: 'omni-cursor',
      itemId: 'perm-number-7',
      kind: 'approval',
      optionId: 'allow-once',
      fence: 1
    })
    expect(connection.replies).toEqual([
      { id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }
    ])
    handlers.onServerRequest?.({
      id: 8,
      method: 'cursor/ask_question',
      params: {
        questions: [
          {
            id: 'q1',
            prompt: 'Which file?',
            options: [{ id: 'a', label: 'A' }]
          }
        ]
      }
    })
    await adapter.answerPrompt({
      sessionId: 'omni-cursor',
      itemId: 'q1',
      kind: 'question',
      optionId: 'a',
      fence: 1
    })
    expect(connection.replies.at(-1)).toMatchObject({
      id: 8,
      result: {
        outcome: {
          outcome: 'answered',
          answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }]
        }
      }
    })
    const journalQuestionId = agentJournalItemKey({
      provider: 'legacy',
      agent: 'cursor',
      sessionId: 'cursor-sess',
      recordId: 'q1'
    })
    handlers.onServerRequest?.({
      id: 9,
      method: 'cursor/ask_question',
      params: {
        questions: [{ id: 'q1', prompt: 'Again?', options: [{ id: 'a', label: 'A' }] }]
      }
    })
    await adapter.answerPrompt({
      sessionId: 'omni-cursor',
      itemId: journalQuestionId,
      kind: 'question',
      optionId: 'a',
      fence: 1
    })
    expect(connection.replies.at(-1)).toMatchObject({
      id: 9,
      result: {
        outcome: {
          outcome: 'answered',
          answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }]
        }
      }
    })
    handlers.onServerRequest?.({
      id: 10,
      method: 'cursor/create_plan',
      params: { name: 'Ship it', plan: '1. Build' }
    })
    expect(items.find((item) => item.body.kind === 'approval')?.body).toMatchObject({
      title: 'Read file'
    })
    expect(items.findLast((item) => item.body.kind === 'approval')?.body).toMatchObject({
      title: 'Ship it'
    })
    await adapter.answerPrompt({
      sessionId: 'omni-cursor',
      itemId: 'plan-10',
      kind: 'approval',
      optionId: 'accept',
      fence: 1
    })
    expect(connection.replies.at(-1)).toEqual({
      id: 10,
      result: { outcome: { outcome: 'accepted' } }
    })
  })

  it('does not authenticate Cursor when the agent advertises no auth methods', async () => {
    const connection = fakeConnection({
      initialize: { authMethods: [] },
      onRequest: (method) => (method === 'session/new' ? { sessionId: 'cursor-sess' } : {})
    })
    const adapter = new AcpStructuredSessionAdapter({
      openConnection: async () => connection,
      resolveLaunch: async () => ({ command: 'agent', args: ['acp'], cwd: '/repo' }),
      readProcessStartTime: async () => 1
    })
    await adapter.acquire({
      identity: {
        sessionId: 'omni-cursor-no-auth',
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'cursor',
        providerHandle: { kind: 'opaque', agent: 'cursor', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'token-no-auth'
    })
    expect(connection.calls.some((call) => call.method === 'authenticate')).toBe(false)
  })
})
