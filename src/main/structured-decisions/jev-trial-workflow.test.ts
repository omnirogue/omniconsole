import { describe, expect, it, vi } from 'vitest'
import { evaluateJevTrialWorkflow } from './jev-trial-workflow'
import type { DecisionResult } from '../../shared/structured-decisions'
import { buildRecipeRequest } from '../../../config/scripts/decision-recipes.mjs'

const adState = { copy: 'The plan costs $10 once.', offer: 'The plan costs $10 once.' }

const validResult: DecisionResult = {
  provider: 'typesafe',
  model: 'jev-1.13.0',
  answers: {
    alignment: {
      type: 'choice',
      choice: 'aligned',
      confidence: 1,
      probabilities: { aligned: 1, conflict: 0, uncertain: 0 }
    },
    mismatch: {
      type: 'score',
      score: 0,
      confidence: 1,
      legend: Object.fromEntries(
        buildRecipeRequest('advertising_review', adState).questions.mismatch.criteria.map(
          (level: string, index: number) => [String(index), level]
        )
      ),
      probabilities: { '0': 1, '1': 0, '2': 0, '3': 0 }
    },
    recurring: { type: 'noul', noul: 0 }
  },
  usage: { inputTokens: 200, outputTokens: 20 }
}

describe('JEV trial workflow', () => {
  it('times out a stalled credential lookup without starting inference later', async () => {
    vi.useFakeTimers()
    try {
      let release!: (key: string) => void
      const credential = new Promise<string>((resolve) => {
        release = resolve
      })
      const evaluate = vi.fn().mockResolvedValue(validResult)
      const pending = evaluateJevTrialWorkflow('advertising_review', adState, {
        credential: () => credential,
        evaluate,
        environment: {}
      })
      await vi.advanceTimersByTimeAsync(5000)
      await expect(pending).resolves.toMatchObject({ status: 'unavailable', reason: 'timeout' })
      release('fixture-credential')
      await Promise.resolve()
      expect(evaluate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call the provider without a local credential or when disabled', async () => {
    const evaluate = vi.fn().mockResolvedValue(validResult)
    const missing = await evaluateJevTrialWorkflow('advertising_review', adState, {
      credential: async () => undefined,
      evaluate,
      environment: {}
    })
    const disabled = await evaluateJevTrialWorkflow('advertising_review', adState, {
      credential: async () => 'fixture-credential',
      evaluate,
      environment: { JEV_DECISIONS_DISABLED: '1' }
    })
    expect(missing).toMatchObject({ status: 'unavailable', reason: 'no_api_key', answers: {} })
    expect(disabled).toMatchObject({ status: 'unavailable', reason: 'disabled', answers: {} })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('returns all three bounded answers and fails closed on an invalid response', async () => {
    const evaluate = vi.fn().mockResolvedValue(validResult)
    const options = { credential: async () => 'fixture-credential', evaluate, environment: {} }
    const success = await evaluateJevTrialWorkflow('advertising_review', adState, options)
    expect(success).toMatchObject({
      status: 'success',
      disposition: 'advisory',
      model: 'jev-1.13.0',
      answers: { alignment: { choice: 'aligned' }, mismatch: { score: 0 }, recurring: { noul: 0 } }
    })
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'recipe_advertising_review',
        state: adState,
        model: 'jev-1.13.0'
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    evaluate.mockResolvedValueOnce({
      ...validResult,
      answers: { alignment: validResult.answers.alignment }
    })
    const invalid = await evaluateJevTrialWorkflow('advertising_review', adState, options)
    expect(invalid).toMatchObject({ status: 'unavailable', disposition: 'review', answers: {} })
  })
})
