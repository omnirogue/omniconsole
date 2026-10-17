import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { listPendingSessionQuestions } from './session-questions-list'

const ASK = JSON.stringify({
  questions: [
    { question: 'Ship now?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }
  ]
})

function status(paneKey: string, patch: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'waiting',
    prompt: '',
    agentType: 'claude',
    toolName: 'AskUserQuestion',
    interactivePrompt: ASK,
    stateStartedAt: 5,
    receivedAt: 5,
    updatedAt: 5,
    ...patch
  } as AgentStatusIpcPayload
}

describe('omni session questions', () => {
  it('lists each pane still waiting on a question, oldest first, with its identity', () => {
    const questions = listPendingSessionQuestions(
      [
        status('tab-2:leaf-1', { stateStartedAt: 20 }),
        status('tab-1:leaf-1', {
          stateStartedAt: 10,
          providerSession: { id: 'claude-session-1' } as AgentStatusIpcPayload['providerSession']
        }),
        status('tab-3:leaf-1', { state: 'working' })
      ],
      (paneKey) => (paneKey === 'tab-1:leaf-1' ? 'toolu_01' : undefined),
      (paneKey) => (paneKey === 'tab-1:leaf-1' ? 'Checkout fix' : null)
    )
    expect(questions).toEqual([
      {
        paneKey: 'tab-1:leaf-1',
        title: 'Checkout fix',
        agent: 'claude',
        askedAt: 10,
        toolUseId: 'toolu_01',
        sessionId: 'claude-session-1',
        questions: [
          {
            question: 'Ship now?',
            multiSelect: false,
            options: [{ label: 'Yes' }, { label: 'No' }]
          }
        ]
      },
      expect.objectContaining({
        paneKey: 'tab-2:leaf-1',
        title: null,
        toolUseId: null,
        sessionId: null
      })
    ])
  })

  it('lists one conversation’s question once when several panes show it', () => {
    // Why: a duplicate resume (or a mirrored runtime) repeats the same hook status under other
    // pane keys; the person is asked once, under the pane that asked first.
    const session = { id: 'claude-session-1' } as AgentStatusIpcPayload['providerSession']
    const questions = listPendingSessionQuestions(
      [
        status('tab-copy:leaf-1', { stateStartedAt: 30, providerSession: session }),
        status('tab-asker:leaf-1', { stateStartedAt: 10, providerSession: session }),
        status('tab-other:leaf-1', {
          stateStartedAt: 20,
          providerSession: { id: 'claude-session-2' } as AgentStatusIpcPayload['providerSession']
        }),
        status('tab-nosession:leaf-1', { stateStartedAt: 40 })
      ],
      (paneKey) => (paneKey === 'tab-asker:leaf-1' ? 'toolu_01' : undefined),
      () => null
    )
    expect(questions.map((question) => [question.paneKey, question.toolUseId])).toEqual([
      ['tab-asker:leaf-1', 'toolu_01'],
      ['tab-other:leaf-1', null],
      ['tab-nosession:leaf-1', null]
    ])
  })

  it('lists a Codex async question riding its finished turn, marked for a message answer', () => {
    const asyncAsk = JSON.stringify({
      delivery: 'async',
      asyncQuestions: [
        { question: 'Which color?', multiSelect: false, options: [{ label: 'Red' }] }
      ]
    })
    const questions = listPendingSessionQuestions(
      [
        status('tab-4:leaf-1', {
          state: 'done',
          agentType: 'codex',
          toolName: 'exec_command',
          interactivePrompt: asyncAsk
        }),
        // A selector question is over once its turn is done; an async one mid-turn is Codex's own.
        status('tab-5:leaf-1', { state: 'done' }),
        status('tab-6:leaf-1', {
          state: 'working',
          agentType: 'codex',
          interactivePrompt: asyncAsk
        })
      ],
      () => undefined,
      () => null
    )
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({
      paneKey: 'tab-4:leaf-1',
      agent: 'codex',
      delivery: 'async'
    })
  })
})
