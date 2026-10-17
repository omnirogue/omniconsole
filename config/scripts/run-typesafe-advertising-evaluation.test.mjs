import { describe, expect, it, vi } from 'vitest'
import { ADVERTISING_EVALUATION_CASES } from './typesafe-advertising-evaluation-corpus.mjs'
import { evaluateNumericAdvertisingReference } from './typesafe-advertising-numeric-reference.mjs'
import { buildEvaluationRequest, runEvaluation } from './run-typesafe-evaluation.mjs'

const selectionCases = () =>
  structuredClone(
    ADVERTISING_EVALUATION_CASES.filter(
      (item) => item.task === 'ad_sibling_selection' && item.split === 'development'
    )
  )

function fakeProviders(calls = []) {
  return Object.fromEntries(
    ['typesafe', 'gemini'].map((arm) => [
      arm,
      vi.fn(async (request) => {
        calls.push({ arm, request })
        return { ...evaluateNumericAdvertisingReference(request), elapsedMs: 5 }
      })
    ])
  )
}

describe('advertising baseline evaluation isolation', () => {
  it('gives every arm the same full request without evaluator-only labels', async () => {
    const cases = selectionCases()
    for (const item of cases) {
      for (const key of ['expected', 'rationale', 'familyId', 'split', 'origin']) {
        Object.defineProperty(item, key, {
          get() {
            throw new Error('evaluator_only_label_accessed')
          }
        })
      }
    }
    const calls = []
    const evaluate = vi.fn(evaluateNumericAdvertisingReference)
    const classifier = vi.fn(() => {
      throw new Error('unrelated_regex_baseline_called')
    })
    const result = await runEvaluation({
      cases,
      providers: fakeProviders(calls),
      classifyAgentTurnFailure: classifier,
      baseline: { arm: 'numeric_reference', evaluate }
    })
    expect(classifier).not.toHaveBeenCalled()
    expect(evaluate).toHaveBeenCalledTimes(cases.length)
    expect(calls.map(({ arm }) => arm)).toEqual([
      'typesafe',
      'gemini',
      'gemini',
      'typesafe',
      'typesafe',
      'gemini',
      'gemini',
      'typesafe'
    ])
    for (const [index, item] of cases.entries()) {
      const expectedRequest = buildEvaluationRequest(item)
      expect(evaluate.mock.calls[index]).toHaveLength(1)
      expect(evaluate.mock.calls[index][0]).toEqual(expectedRequest)
      expect(calls[index * 2].request).toEqual(expectedRequest)
      expect(calls[index * 2 + 1].request).toEqual(expectedRequest)
      expect(Object.keys(expectedRequest).sort()).toEqual([
        'capability',
        'model',
        'questions',
        'state'
      ])
      for (const key of ['id', 'expected', 'rationale', 'familyId', 'split', 'origin', 'task']) {
        expect(expectedRequest).not.toHaveProperty(key)
      }
    }
    expect(result.requests).toBe(cases.length * 2)
    expect(result.batching).toEqual([])
    expect(result.observations.filter(({ arm }) => arm === 'existing_regex')).toEqual([])
    expect(result.observations.filter(({ arm }) => arm === 'numeric_reference')).toHaveLength(
      cases.length
    )
  })

  it('records all authored baseline outputs and leaves corpus facts unchanged', async () => {
    const cases = selectionCases()
    const before = structuredClone(cases)
    const result = await runEvaluation({
      cases,
      providers: fakeProviders(),
      baseline: { arm: 'numeric_reference', evaluate: evaluateNumericAdvertisingReference }
    })
    expect(cases).toEqual(before)
    const observations = result.observations.filter(({ arm }) => arm === 'numeric_reference')
    expect(observations).toHaveLength(cases.length)
    for (const item of cases) {
      expect(observations.find(({ caseId }) => caseId === item.id)).toMatchObject({
        status: 'success',
        answers: item.expected,
        usage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0
      })
    }
  })

  it.each([
    null,
    0,
    {},
    { arm: 'typesafe', evaluate: evaluateNumericAdvertisingReference },
    { arm: 'existing_regex', evaluate: evaluateNumericAdvertisingReference },
    { arm: 'numeric_reference' },
    { arm: 'numeric_reference', evaluate: 'not-a-function' }
  ])('rejects invalid baseline configuration before any provider calls: %j', async (baseline) => {
    const providers = fakeProviders()
    const classifier = vi.fn()
    await expect(
      runEvaluation({
        cases: selectionCases(),
        providers,
        classifyAgentTurnFailure: classifier,
        baseline
      })
    ).rejects.toThrow('evaluation_invalid_baseline')
    expect(providers.typesafe).not.toHaveBeenCalled()
    expect(providers.gemini).not.toHaveBeenCalled()
    expect(classifier).not.toHaveBeenCalled()
  })
})
