import { describe, expect, it } from 'vitest'
import { agentHookIsAsking, sessionAttemptAwaiting } from './session-outcome-attempt-awaiting'

type Hook = {
  state: string
  interactivePrompt: string | null
  lastAssistantMessage: string | null
  stateStartedAt?: number
}

const hook = (overrides: Partial<Hook> = {}): Hook => ({
  state: 'waiting',
  interactivePrompt: null,
  lastAssistantMessage: null,
  stateStartedAt: 1_000,
  ...overrides
})

describe('an agent asking its person something', () => {
  it('is only the waiting, blocked and permission hook states', () => {
    expect(agentHookIsAsking(hook())).toBe(true)
    expect(agentHookIsAsking(hook({ state: 'blocked' }))).toBe(true)
    expect(agentHookIsAsking(hook({ state: 'permission' }))).toBe(true)
    expect(agentHookIsAsking(hook({ state: 'working' }))).toBe(false)
    expect(agentHookIsAsking(hook({ state: 'done' }))).toBe(false)
    expect(agentHookIsAsking(null)).toBe(false)
  })

  it('counts a Codex async question riding its finished turn, as a clarification', () => {
    const asked = hook({
      state: 'done',
      interactivePrompt: JSON.stringify({
        delivery: 'async',
        asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [] }]
      })
    })
    expect(agentHookIsAsking(asked)).toBe(true)
    expect(sessionAttemptAwaiting(asked, undefined, 'tab-1:pane-1', 5_000)).toMatchObject({
      kind: 'clarification',
      prompt: 'Which color?'
    })
    const selector = JSON.stringify({ questions: [{ question: 'Ship?', options: [] }] })
    expect(agentHookIsAsking(hook({ state: 'done', interactivePrompt: selector }))).toBe(false)
  })

  it('reads an approval envelope as a permission and a question envelope as a clarification', () => {
    expect(
      sessionAttemptAwaiting(
        hook({
          state: 'blocked',
          interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'git push' } })
        }),
        undefined,
        'tab-1:pane-1',
        5_000
      )
    ).toEqual({
      kind: 'permission',
      prompt: 'Bash git push',
      since: 1_000,
      paneKey: 'tab-1:pane-1'
    })
    expect(
      sessionAttemptAwaiting(
        hook({
          interactivePrompt: JSON.stringify({
            questions: [{ question: 'Postgres or SQLite?' }, { question: 'Which port?' }]
          })
        }),
        undefined,
        null,
        5_000
      )
    ).toEqual({ kind: 'clarification', prompt: 'Postgres or SQLite? Which port?', since: 1_000 })
  })

  it('falls back to what the agent last said, and always has something to ask', () => {
    expect(
      sessionAttemptAwaiting(
        hook({ lastAssistantMessage: 'Should I overwrite  the\nexisting file?' }),
        undefined,
        undefined,
        5_000
      ).prompt
    ).toBe('Should I overwrite the existing file?')
    expect(
      sessionAttemptAwaiting(hook({ stateStartedAt: undefined }), undefined, undefined, 5_000)
    ).toEqual({ kind: 'clarification', prompt: 'The agent needs your input.', since: 5_000 })
  })

  it('keeps `since` while the same prompt is re-observed, and restarts it for a new one', () => {
    const first = sessionAttemptAwaiting(
      hook({ lastAssistantMessage: 'Proceed?' }),
      undefined,
      undefined,
      5_000
    )
    const again = sessionAttemptAwaiting(
      hook({ lastAssistantMessage: 'Proceed?', stateStartedAt: 7_000 }),
      first,
      undefined,
      9_000
    )
    expect(again.since).toBe(first.since)
    const next = sessionAttemptAwaiting(
      hook({ lastAssistantMessage: 'And the tests?', stateStartedAt: 7_000 }),
      first,
      undefined,
      9_000
    )
    expect(next.since).toBe(7_000)
  })

  it('never produces a shape the strict set schema would refuse', () => {
    const awaiting = sessionAttemptAwaiting(
      hook({ lastAssistantMessage: 'x'.repeat(5_000), stateStartedAt: -1 }),
      undefined,
      'p'.repeat(400),
      5_000
    )
    expect(awaiting).toEqual({
      kind: 'clarification',
      prompt: 'The agent needs your input.',
      since: 5_000
    })
  })
})
