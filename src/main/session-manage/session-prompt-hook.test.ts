import { describe, expect, it } from 'vitest'
import { derivePtyActivity } from './session-manage-pty-activity'
import { projectSessionState } from './session-manage-state'
import { readSessionHookQuestion } from './session-prompt-hook'

const ASYNC_ASK = JSON.stringify({
  delivery: 'async',
  asyncQuestions: [
    {
      question: 'Which color?',
      multiSelect: false,
      options: [{ label: 'Red' }, { label: 'Blue' }]
    }
  ]
})

describe('a Codex async question in omni session', () => {
  it('lists the finished turn that carries it as awaiting-user', () => {
    const { activity } = derivePtyActivity({
      status: { running: true, status: 'idle' },
      title: 'idle',
      hook: { state: 'done', interactivePrompt: ASYNC_ASK, updatedAt: 1_000, agentPid: 200 },
      lastHook: null,
      screen: null,
      foregroundAgent: 'codex',
      agentInForeground: true
    })
    expect(
      projectSessionState({ verdict: 'live', activity, queueLength: 0, pendingSteps: [] }).state
    ).toBe('awaiting-user')
  })

  it('refuses keystrokes and points at a message answer', () => {
    const prompt = readSessionHookQuestion(ASYNC_ASK)!
    expect(prompt.ask.text).toBe('Which color?')
    expect(prompt.delivery).toMatchObject({ kind: 'unavailable' })
    expect(prompt.delivery.kind === 'unavailable' && prompt.delivery.reason).toMatch(
      /takes a message/
    )
  })
})
