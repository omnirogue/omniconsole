import { describe, expect, it, vi } from 'vitest'
import type { PlannedItem, PreparedFields } from '../../shared/session-prep-types'
import { gate, type SessionPrepGateDeps } from './session-prep-gate'

const item: PlannedItem = {
  title: 'Login fix',
  ask: 'Fix the login timeout',
  anchor: 'login timeout',
  direct: false,
  changesCode: true
}

function fields(overrides: Partial<PreparedFields> = {}): PreparedFields {
  return {
    title: 'Login fix',
    outcome: 'Existing users can sign in.',
    doneWhen: ['Login test passes', 'Sign-in accepts a valid account'],
    decided: [],
    references: [{ path: 'src/auth.ts', why: 'handles login' }],
    constraints: [],
    assumptions: [],
    blockingQuestion: null,
    changesCode: true,
    ...overrides
  }
}

const input = {
  item,
  fields: fields(),
  request: 'Fix the login timeout',
  context: 'User: the login times out after 5s',
  cwd: '/ws'
}

function deps(overrides: Partial<SessionPrepGateDeps> = {}): SessionPrepGateDeps {
  return {
    runText: vi.fn(async () => {
      throw new Error('model should not run')
    }),
    jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9 })),
    pathExists: vi.fn(async () => true),
    agent: 'claude',
    model: 'sonnet',
    effort: 'low',
    timeoutMs: 90_000,
    ...overrides
  }
}

describe('gate', () => {
  it.each([false, true])('propagates model auth refusal (ambiguous ask: %s)', async (ambiguous) => {
    const refusal = new Error('Failed to authenticate: OAuth session expired')
    const runText = vi.fn().mockRejectedValue(refusal)
    await expect(
      gate(
        {
          ...input,
          fields: fields({
            blockingQuestion: ambiguous
              ? { question: 'Who receives it?', options: ['A', 'B'], why: 'missing recipient' }
              : null
          })
        },
        deps({
          runText,
          jevAsk: ambiguous
            ? async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.6 })
            : undefined
        })
      )
    ).rejects.toBe(refusal)
    expect(runText).toHaveBeenCalledTimes(1)
  })

  it('passes when JEV scores are high', async () => {
    const result = await gate(input, deps())
    expect(result.pass).toBe(true)
    expect(result.judge).toBe('jev')
    expect(result.ask).toBeNull()
    expect(result.failures).toEqual([])
  })

  it('fails when consistent is below 0.5', async () => {
    const result = await gate(
      input,
      deps({ jevAsk: vi.fn(async () => ({ consistent: 0.4, ready: 0.9 })) })
    )
    expect(result.pass).toBe(false)
    expect(result.judge).toBe('jev')
    expect(result.failures.some((failure) => failure.code === 'contradiction')).toBe(true)
  })

  it('fails when ready is below 0.5', async () => {
    const result = await gate(
      input,
      deps({ jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.2 })) })
    )
    expect(result.pass).toBe(false)
    expect(result.failures.some((failure) => failure.code === 'not-ready')).toBe(true)
  })

  it('sets ask when needs_user is at least 0.8', async () => {
    const blocking = {
      question: 'Who receives the report?',
      options: ['Sal', 'Uma'],
      why: 'named recipient'
    }
    const result = await gate(
      { ...input, fields: fields({ blockingQuestion: blocking }) },
      deps({
        jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.85 }))
      })
    )
    expect(result.pass).toBe(true)
    expect(result.ask).toEqual({ question: blocking.question, options: blocking.options })
    expect(result.failures).toEqual([])
  })

  it('fails needless-question when needs_user is below 0.5', async () => {
    const result = await gate(
      {
        ...input,
        fields: fields({
          blockingQuestion: { question: 'Use tabs or spaces?', options: [], why: 'style' }
        })
      },
      deps({ jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.2 })) })
    )
    expect(result.pass).toBe(false)
    expect(result.ask).toBeNull()
    expect(result.failures.some((failure) => failure.code === 'needless-question')).toBe(true)
  })

  it('uses the model judge in the needs_user mid-band when the model says true', async () => {
    const runText = vi.fn(async () => '{"needs_user": true}')
    const blocking = { question: 'Which customer list?', options: ['A', 'B'], why: 'policy' }
    const result = await gate(
      { ...input, fields: fields({ blockingQuestion: blocking }) },
      deps({
        runText,
        jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.6 }))
      })
    )
    expect(result.judge).toBe('model')
    expect(result.pass).toBe(true)
    expect(result.ask).toEqual({ question: blocking.question, options: blocking.options })
    expect(runText).toHaveBeenCalled()
  })

  it('launches with the question when the only failures come from the pending answer', async () => {
    const blocking = {
      question: 'What is the new plan name?',
      options: [],
      why: 'only Sal picked it'
    }
    const result = await gate(
      {
        ...input,
        fields: fields({
          blockingQuestion: blocking,
          outcome: 'The plan is renamed to [NEW NAME].'
        })
      },
      deps({
        jevAsk: vi.fn(async () => ({ consistent: 0.38, ready: 0.14, needs_user: 0.95 }))
      })
    )
    expect(result.ask).toEqual({ question: blocking.question, options: blocking.options })
    expect(result.pass).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('still repairs a missing reference when a question is accepted', async () => {
    const blocking = {
      question: 'What is the new plan name?',
      options: [],
      why: 'only Sal picked it'
    }
    const result = await gate(
      { ...input, fields: fields({ blockingQuestion: blocking }) },
      deps({
        pathExists: vi.fn(async () => false),
        jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.95 }))
      })
    )
    expect(result.ask).not.toBeNull()
    expect(result.pass).toBe(false)
    expect(result.failures.map((failure) => failure.code)).toEqual(['missing-reference'])
  })

  it('keeps the question when JEV is unsure and the model judge fails', async () => {
    const blocking = { question: 'Which customer list?', options: ['A', 'B'], why: 'policy' }
    const result = await gate(
      { ...input, fields: fields({ blockingQuestion: blocking }) },
      deps({
        runText: vi.fn(async () => {
          throw new Error('judge down')
        }),
        jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.7 }))
      })
    )
    expect(result.pass).toBe(true)
    expect(result.ask).toEqual({ question: blocking.question, options: blocking.options })
    expect(result.failures.some((failure) => failure.code === 'needless-question')).toBe(false)
  })

  it('uses the model judge in the needs_user mid-band when the model says false', async () => {
    const runText = vi.fn(async () => '{"needs_user": false}')
    const result = await gate(
      {
        ...input,
        fields: fields({
          blockingQuestion: { question: 'Which customer list?', options: ['A', 'B'], why: 'policy' }
        })
      },
      deps({
        runText,
        jevAsk: vi.fn(async () => ({ consistent: 0.9, ready: 0.9, needs_user: 0.65 }))
      })
    )
    expect(result.judge).toBe('model')
    expect(result.pass).toBe(false)
    expect(result.ask).toBeNull()
    expect(result.failures.some((failure) => failure.code === 'needless-question')).toBe(true)
  })

  it('falls back to the model judge when jevAsk throws and there are no deterministic failures', async () => {
    const runText = vi.fn(async () => '{"consistent": true, "ready": true}')
    const result = await gate(
      input,
      deps({
        runText,
        jevAsk: vi.fn(async () => {
          throw new Error('jev down')
        })
      })
    )
    expect(result.judge).toBe('model')
    expect(result.pass).toBe(true)
    expect(runText).toHaveBeenCalled()
  })

  it('skips the model judge when jevAsk throws and deterministic failures already exist', async () => {
    const runText = vi.fn(async () => '{"consistent": true, "ready": true}')
    const result = await gate(
      { ...input, fields: fields({ outcome: '' }) },
      deps({
        runText,
        jevAsk: vi.fn(async () => {
          throw new Error('jev down')
        })
      })
    )
    expect(result.judge).toBe('deterministic')
    expect(result.pass).toBe(false)
    expect(result.scores).toEqual({})
    expect(runText).not.toHaveBeenCalled()
  })

  it('keeps a contradiction JEV is confident about even when a question is accepted', async () => {
    const blocking = {
      question: 'What is the new plan name?',
      options: [],
      why: 'only Sal picked it'
    }
    const result = await gate(
      { ...input, fields: fields({ blockingQuestion: blocking }) },
      deps({
        jevAsk: vi.fn(async () => ({ consistent: 0.1, ready: 0.14, needs_user: 0.95 }))
      })
    )
    expect(result.ask).toEqual({ question: blocking.question, options: blocking.options })
    expect(result.pass).toBe(false)
    expect(result.failures.map((failure) => failure.code)).toEqual(['contradiction'])
  })

  it('records why JEV could not run', async () => {
    const thrown = await gate(
      input,
      deps({
        runText: vi.fn(async () => '{"consistent": true, "ready": true}'),
        jevAsk: vi.fn(async () => {
          throw new Error('jev down')
        })
      })
    )
    expect(thrown.jevError).toBe('jev down')

    const unset = await gate(
      input,
      deps({ runText: vi.fn(async () => '{"consistent": true, "ready": true}'), jevAsk: undefined })
    )
    expect(unset.judge).toBe('model')
    expect(unset.jevError).toBe('JEV is not configured')

    const scored = await gate(input, deps())
    expect(scored).not.toHaveProperty('jevError')
  })

  it('adds missing-reference when pathExists is false', async () => {
    const pathExists = vi.fn(async () => false)
    const result = await gate(input, deps({ pathExists }))
    expect(result.failures.some((failure) => failure.code === 'missing-reference')).toBe(true)
    expect(pathExists).toHaveBeenCalledWith('/ws', 'src/auth.ts')
  })

  it('checks absolute paths through pathExists and refuses .. paths outright', async () => {
    const pathExists = vi.fn(async () => false)
    const absolute = await gate(
      {
        ...input,
        fields: fields({ references: [{ path: '/etc/passwd', why: 'nope' }] })
      },
      deps({ pathExists })
    )
    expect(absolute.failures.some((failure) => failure.code === 'missing-reference')).toBe(true)
    expect(pathExists).toHaveBeenCalledWith('/ws', '/etc/passwd')

    pathExists.mockClear()
    const parent = await gate(
      {
        ...input,
        fields: fields({ references: [{ path: '../secret.ts', why: 'nope' }] })
      },
      deps({ pathExists })
    )
    expect(parent.failures.some((failure) => failure.code === 'missing-reference')).toBe(true)
    expect(pathExists).not.toHaveBeenCalled()
  })
})
