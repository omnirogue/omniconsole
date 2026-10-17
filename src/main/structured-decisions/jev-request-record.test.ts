import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { JevRequestInput } from '../../shared/jev-control'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { buildRecipeRequest } from '../../../config/scripts/decision-recipes.mjs'
import { evaluateJevRequest } from './jev-request-record'
import { persistJevRecord } from './jev-record-storage'

const input = {
  recipeId: 'support_triage',
  state: { message: 'Fictional customer: the parcel has not arrived.' }
} satisfies JevRequestInput

/** A valid closed answer for every question, so the recipe's own disposition rules decide. */
function answering(request: DecisionRequest): DecisionResult {
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      if (question.type === 'noul') {
        return [id, { type: 'noul' as const, noul: 0.02 }]
      }
      const keys =
        question.type === 'choice'
          ? Object.keys(question.criteria)
          : question.criteria.map((_, index) => String(index))
      const probabilities = Object.fromEntries(keys.map((key, index) => [key, index ? 0 : 1]))
      return question.type === 'choice'
        ? [id, { type: 'choice' as const, choice: keys[0]!, confidence: 1, probabilities }]
        : [
            id,
            {
              type: 'score' as const,
              score: 0,
              confidence: 1,
              probabilities,
              legend: Object.fromEntries(question.criteria.map((level, index) => [index, level]))
            }
          ]
    })
  )
  return {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 90, outputTokens: 9 }
  }
}

describe('jev-request-record/1', () => {
  it('records off and host-off requests without a credential lookup or provider call', async () => {
    const evaluate = vi.fn()
    const credential = vi.fn()
    for (const [control, disabled] of [
      ['off', false],
      ['request', true]
    ] as const) {
      const { record, call } = await evaluateJevRequest(input, {
        control,
        disabled,
        evaluate,
        credential
      })
      expect(call).toMatchObject({ calls: 0, providerStatus: 'not_called' })
      expect(call.questionIds).toEqual(
        Object.keys(buildRecipeRequest('support_triage', input.state, 1).questions)
      )
      expect(record).toMatchObject({
        schema_version: 'jev-request-record/1',
        recipe_ref: 'support_triage@1',
        control: { requested: control, effective: 'off' },
        confidence_origin: 'unavailable',
        decision_escalation: 'never',
        action_authorized: false,
        result: { status: 'unavailable', disposition: 'review', reason: 'disabled', answers: {} }
      })
      expect(record.result.inputHash).toBe(
        createHash('sha256').update(JSON.stringify(input)).digest('hex')
      )
      expect(JSON.stringify(record)).not.toContain('parcel')
    }
    expect(evaluate).not.toHaveBeenCalled()
    expect(credential).not.toHaveBeenCalled()
  })

  it.each([
    ['support_triage', { message: 'Fictional: how do I reset my password?' }],
    ['retrieval_review', { query: 'refund window', passage: 'Fictional policy: 14 days.' }],
    ['lead_fit', { lead: 'Fictional bakery with three sites', criteria: 'Multi-site food' }]
  ] as const)('returns native readings for %s', async (recipeId, state) => {
    const recipeInput = { recipeId, state } as JevRequestInput
    const evaluate = vi.fn(async (request: DecisionRequest) => answering(request))
    const { record, call } = await evaluateJevRequest(recipeInput, {
      control: 'request',
      evaluate,
      credential: async () => 'fixture-credential',
      environment: {}
    })
    expect(call).toMatchObject({ calls: 1, providerStatus: 'evaluated' })
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ capability: `recipe_${recipeId}`, state }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(record).toMatchObject({
      recipe_ref: `${recipeId}@1`,
      control: { requested: 'request', effective: 'on' },
      confidence_origin: 'native-typesafe',
      result: { status: 'success', model: 'jev-1.13.0', usage: { inputTokens: 90 } }
    })
    expect(Object.keys(record.result.answers)).toEqual(
      Object.keys(buildRecipeRequest(recipeId, state, 1).questions)
    )
  })

  it('stores every request under jev-request:<id> and reports a failed write', async () => {
    const { record } = await evaluateJevRequest(input, { control: 'off' })
    const key = `jev-request:${record.request_id}`
    const write = vi.fn().mockResolvedValueOnce(undefined)
    const saved = await persistJevRecord({ write }, key, record)
    expect(saved.storage).toEqual({ status: 'saved', key })
    expect(write).toHaveBeenCalledExactlyOnceWith('result', key, saved, expect.anything())

    write.mockRejectedValueOnce(new Error('disk full'))
    const failed = await persistJevRecord({ write }, key, record)
    expect(failed).toEqual({
      ...record,
      storage: { status: 'failed', key, reason: 'record_write_failed' }
    })
  })
})
