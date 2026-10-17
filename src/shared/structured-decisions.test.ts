import { describe, expect, it, vi } from 'vitest'
import {
  DECISION_MAX_INPUT_BYTES,
  DecisionProviderError,
  snapshotDecisionRequest,
  validateDecisionResult,
  type DecisionRequest,
  type DecisionResult,
  type DecisionValue
} from './structured-decisions'

function request(): DecisionRequest {
  return {
    capability: 'editor.intent',
    state: { message: 'Inspect the branch', files: ['app.ts'] },
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Classify the requested operation.',
        criteria: { inspect: 'Read existing information.', modify: null }
      },
      effort: {
        type: 'score',
        instructions: { task: 'Estimate effort.' },
        criteria: ['Low', { label: 'Medium' }, ['High']]
      },
      explicit: { type: 'noul', instructions: 'Does this explicitly request edits?' }
    }
  }
}

function result(): DecisionResult {
  return {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    answers: {
      intent: {
        type: 'choice',
        choice: 'inspect',
        probabilities: { inspect: 0.8, modify: 0.2 },
        confidence: 0.6
      },
      effort: {
        type: 'score',
        score: 1.1,
        legend: { '0': 'Low', '1': { label: 'Medium' }, '2': ['High'] },
        probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 },
        confidence: 0.4
      },
      explicit: { type: 'noul', noul: 0.03 }
    },
    usage: { inputTokens: 240, outputTokens: 30 },
    requestId: 'req-123'
  }
}

function expectInvalidResult(value: unknown): void {
  expect(() => validateDecisionResult(value as DecisionResult, request())).toThrow(
    new DecisionProviderError('invalid_response')
  )
}

describe('snapshotDecisionRequest', () => {
  it('snapshots structured state and rubrics without retaining mutable references', () => {
    const input = request()
    input.routineId = undefined
    const snapshot = snapshotDecisionRequest(input)

    expect(snapshot).toEqual(request())
    expect(snapshot).not.toBe(input)
    expect(snapshot.state).not.toBe(input.state)
    expect(snapshot.questions.effort).not.toBe(input.questions.effort)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.state)).toBe(true)
    expect(Object.isFrozen(snapshot.questions.effort)).toBe(true)
    if (input.questions.effort.type !== 'score') {
      throw new Error('Unexpected fixture')
    }
    input.questions.effort.criteria[0] = 'Changed'
    expect(snapshot.questions.effort).toMatchObject({
      criteria: ['Low', { label: 'Medium' }, ['High']]
    })
  })

  it('enforces the serialized UTF-8 byte limit, including multibyte input', () => {
    const input = { ...request(), state: '' }
    const overhead = new TextEncoder().encode(JSON.stringify(input)).byteLength
    input.state = 'x'.repeat(DECISION_MAX_INPUT_BYTES - overhead)
    expect(snapshotDecisionRequest(input).state).toBe(input.state)
    input.state += 'x'
    expect(() => snapshotDecisionRequest(input)).toThrow(
      new DecisionProviderError('input_too_large')
    )
    input.state = '🐋'.repeat(DECISION_MAX_INPUT_BYTES / 4)
    expect(() => snapshotDecisionRequest(input)).toThrow(
      new DecisionProviderError('input_too_large')
    )
  })

  it('rejects cycles and excessive nesting before schema traversal', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() =>
      snapshotDecisionRequest({ ...request(), state: cycle } as DecisionRequest)
    ).toThrow(DecisionProviderError)
    let state: DecisionValue = 'leaf'
    for (let index = 0; index < 25; index += 1) {
      state = [state]
    }
    expect(() => snapshotDecisionRequest({ ...request(), state })).toThrow(
      new DecisionProviderError('input_too_large')
    )
  })

  it('refuses enormous sparse arrays before serialization can expand their holes', () => {
    const state: DecisionValue = []
    state.length = DECISION_MAX_INPUT_BYTES + 1
    expect(() => snapshotDecisionRequest({ ...request(), state })).toThrow(
      new DecisionProviderError('input_too_large')
    )
  })

  it('bounds structurally dense JSON even when its serialized bytes fit', () => {
    const state = Array.from({ length: 10_001 }, () => [])
    expect(() => snapshotDecisionRequest({ ...request(), state })).toThrow(DecisionProviderError)
  })

  it('refuses getters without invoking them or their serialization hooks', () => {
    const getter = vi.fn(() => 'private text')
    const state = Object.defineProperty({}, 'text', { enumerable: true, get: getter })
    expect(() => snapshotDecisionRequest({ ...request(), state })).toThrow(
      new DecisionProviderError('invalid_request')
    )
    expect(getter).not.toHaveBeenCalled()
    const toJSON = vi.fn(() => 'private text')
    expect(() =>
      snapshotDecisionRequest({ ...request(), state: { toJSON } } as unknown as DecisionRequest)
    ).toThrow(new DecisionProviderError('invalid_request'))
    expect(toJSON).not.toHaveBeenCalled()
  })

  it.each([
    null,
    true,
    3,
    new Date(0),
    { nested: undefined },
    { nested: Number.NaN },
    { nested: Infinity }
  ])('rejects invalid state %j', (state) => {
    expect(() => snapshotDecisionRequest({ ...request(), state } as DecisionRequest)).toThrow(
      new DecisionProviderError('invalid_request')
    )
  })

  it.each([
    { questions: {} },
    { capability: 'contains spaces' },
    { model: 'https://untrusted.example/model' },
    { questions: { unknown: { type: 'chat', instructions: 'Generate text.' } } },
    { questions: { intent: { type: 'choice', instructions: 'Pick.', criteria: { only: 'One' } } } },
    {
      questions: { intent: { type: 'choice', instructions: 'Pick.', criteria: { a: 1, b: 'Two' } } }
    },
    {
      questions: {
        score: { type: 'score', instructions: 'Rate.', criteria: { '0': 'Low', '1': 'High' } }
      }
    },
    { questions: { score: { type: 'score', instructions: 'Rate.', criteria: ['Low'] } } },
    { questions: { score: { type: 'score', instructions: 'Rate.', criteria: ['Low', null] } } },
    { questions: { yes: { type: 'noul', instructions: 'Yes?', criteria: { maybe: 'Perhaps' } } } },
    { questions: { yes: { type: 'noul', instructions: 'Yes?', extra: 'unexpected' } } },
    { extra: 'unexpected' }
  ])('rejects invalid request fields %j', (fields) => {
    expect(() => snapshotDecisionRequest({ ...request(), ...fields } as DecisionRequest)).toThrow(
      new DecisionProviderError('invalid_request')
    )
  })

  it('accepts the question and choice limits and rejects one additional item', () => {
    const noul = { type: 'noul' as const, instructions: 'Yes?' }
    const questions = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`q${index}`, noul])
    )
    expect(
      Object.keys(snapshotDecisionRequest({ ...request(), questions }).questions)
    ).toHaveLength(64)
    questions.q64 = noul
    expect(() => snapshotDecisionRequest({ ...request(), questions })).toThrow(
      DecisionProviderError
    )

    const criteria = Object.fromEntries(
      Array.from({ length: 255 }, (_, index) => [`c${index}`, null])
    )
    const choice = { type: 'choice' as const, instructions: 'Pick.', criteria }
    expect(
      snapshotDecisionRequest({ ...request(), questions: { choice } }).questions.choice
    ).toEqual(choice)
    criteria.c255 = null
    expect(() => snapshotDecisionRequest({ ...request(), questions: { choice } })).toThrow(
      DecisionProviderError
    )
  })

  it('accepts two through ten score levels and rejects eleven', () => {
    for (const count of [2, 10]) {
      const score = {
        type: 'score' as const,
        instructions: 'Rate.',
        criteria: Array.from({ length: count }, (_, i) => String(i))
      }
      expect(
        snapshotDecisionRequest({ ...request(), questions: { score } }).questions.score
      ).toEqual(score)
    }
    const score = {
      type: 'score' as const,
      instructions: 'Rate.',
      criteria: Array.from({ length: 11 }, (_, i) => String(i))
    }
    expect(() => snapshotDecisionRequest({ ...request(), questions: { score } })).toThrow(
      DecisionProviderError
    )
  })
})

describe('validateDecisionResult', () => {
  it('retains fractional scores, structured legends and independent confidence values', () => {
    expect(validateDecisionResult(result(), request())).toEqual(result())
  })

  it('requires exactly the requested question IDs and matching primitive types', () => {
    const missing = result()
    delete missing.answers.explicit
    expectInvalidResult(missing)
    const extra = result()
    extra.answers.unrequested = { type: 'noul', noul: 0.5 }
    expectInvalidResult(extra)
    const substituted = result()
    substituted.answers.intent = { type: 'noul', noul: 0.8 }
    expectInvalidResult(substituted)
  })

  it.each([
    { inspect: 0.8 },
    { inspect: 0.8, modify: 0.2, other: 0 },
    { inspect: 0.8, modify: 0.3 },
    { inspect: 1.1, modify: -0.1 },
    { inspect: Number.NaN, modify: 0.2 },
    { inspect: Infinity, modify: 0.2 },
    { inspect: '0.8', modify: 0.2 }
  ])('rejects malformed probability distributions %j', (probabilities) => {
    const candidate = result()
    candidate.answers.intent = {
      ...candidate.answers.intent,
      probabilities
    } as typeof candidate.answers.intent
    expectInvalidResult(candidate)
  })

  it('accepts probabilities rounded to two decimals, and nothing further off', () => {
    // A live JEV answer: five options rounded to hundredths sum to 0.99.
    const five: DecisionRequest = {
      ...request(),
      questions: {
        driver: {
          type: 'choice',
          instructions: 'Which criterion decided?',
          criteria: { a: null, b: null, c: null, d: null, e: null }
        }
      }
    }
    const answer = (probabilities: Record<string, number>): DecisionResult => ({
      ...result(),
      answers: { driver: { type: 'choice', choice: 'c', probabilities, confidence: 0.6 } }
    })
    const rounded = { a: 0.26, b: 0, c: 0.68, d: 0.03, e: 0.02 }
    expect(validateDecisionResult(answer(rounded), five).answers.driver).toMatchObject({
      choice: 'c'
    })
    expect(() =>
      validateDecisionResult(answer({ a: 0.2, b: 0, c: 0.68, d: 0.03, e: 0.02 }), five)
    ).toThrow(new DecisionProviderError('invalid_response'))
    // Scores: rounded levels move the implied score by up to 0.005 per level index.
    const scored = result()
    scored.answers.effort = {
      ...scored.answers.effort,
      probabilities: { '0': 0.33, '1': 0.33, '2': 0.33 },
      score: 1
    } as typeof scored.answers.effort
    expect(validateDecisionResult(scored, request()).answers.effort).toMatchObject({ score: 1 })
  })

  it('accepts a choice that trails the maximum only by rounding', () => {
    // Live JEV session classification: choice 0.37, another option 0.38 after rounding.
    const five: DecisionRequest = {
      ...request(),
      questions: {
        next: {
          type: 'choice',
          instructions: 'How actionable is the next step?',
          criteria: { a: null, b: null, c: null, d: null, e: null }
        }
      }
    }
    const answer = (choice: string, probabilities: Record<string, number>): DecisionResult => ({
      ...result(),
      answers: { next: { type: 'choice', choice, probabilities, confidence: 0.4 } }
    })
    expect(
      validateDecisionResult(answer('b', { a: 0.38, b: 0.37, c: 0.15, d: 0.05, e: 0.05 }), five)
        .answers.next
    ).toMatchObject({ choice: 'b' })
    expect(() =>
      validateDecisionResult(answer('b', { a: 0.39, b: 0.37, c: 0.14, d: 0.05, e: 0.05 }), five)
    ).toThrow(new DecisionProviderError('invalid_response'))
  })

  it('requires a known highest-probability choice but accepts an exact tie', () => {
    for (const choice of ['missing', 'modify']) {
      const candidate = result()
      candidate.answers.intent = {
        ...candidate.answers.intent,
        choice
      } as typeof candidate.answers.intent
      expectInvalidResult(candidate)
    }
    const candidate = result()
    candidate.answers.intent = {
      type: 'choice',
      choice: 'modify',
      probabilities: { inspect: 0.5, modify: 0.5 },
      confidence: 0
    }
    expect(validateDecisionResult(candidate, request()).answers.intent).toEqual(
      candidate.answers.intent
    )
  })

  it.each([-0.1, 1.1, Number.NaN, Infinity, '0.5', null])(
    'rejects invalid confidence or Noul probability %j',
    (value) => {
      const choice = result()
      choice.answers.intent = {
        ...choice.answers.intent,
        confidence: value
      } as typeof choice.answers.intent
      expectInvalidResult(choice)
      const noul = result()
      noul.answers.explicit = { type: 'noul', noul: value } as typeof noul.answers.explicit
      expectInvalidResult(noul)
    }
  )

  it.each([-1, 2.1, 1.2, Number.NaN, Infinity, '1.1'])(
    'rejects out-of-range or inconsistent scores %j',
    (score) => {
      const candidate = result()
      candidate.answers.effort = {
        ...candidate.answers.effort,
        score
      } as typeof candidate.answers.effort
      expectInvalidResult(candidate)
    }
  )

  it.each([
    { '0': 'Low', '1': { label: 'Medium' } },
    { '0': 'Low', '1': { label: 'Medium' }, '2': ['High'], '3': 'Extra' },
    { '0': 'Low', '1': { label: 'Different' }, '2': ['High'] }
  ])('rejects missing, extra or changed score legend entries %j', (legend) => {
    const candidate = result()
    candidate.answers.effort = {
      ...candidate.answers.effort,
      legend
    } as typeof candidate.answers.effort
    expectInvalidResult(candidate)
  })

  it.each([
    { provider: '' },
    { model: 'invalid model' },
    { requestId: 'private text with spaces' },
    { usage: { inputTokens: -1, outputTokens: 0 } },
    { usage: { inputTokens: 1.5, outputTokens: 0 } },
    { usage: { inputTokens: 1, outputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { inputTokens: 1 } }
  ])('rejects malformed metadata %j', (fields) => {
    expectInvalidResult({ ...result(), ...fields })
  })

  it('strips unknown provider fields at the result, answer and usage boundaries', () => {
    const candidate = result()
    const decorated = {
      ...candidate,
      rawState: 'private-state-marker',
      usage: { ...candidate.usage, error: 'private-error-marker' },
      answers: Object.fromEntries(
        Object.entries(candidate.answers).map(([id, answer]) => [
          id,
          {
            ...answer,
            rawText: 'private-answer-marker',
            internal: { credential: 'fake-secret' }
          }
        ])
      )
    }

    const sanitized = validateDecisionResult(decorated as DecisionResult, request())
    expect(sanitized).toEqual(candidate)
    expect(JSON.stringify(sanitized)).not.toContain('private-')
    expect(sanitized.usage).not.toBe(decorated.usage)
    expect(sanitized.answers.intent).not.toBe(decorated.answers.intent)
  })
})
