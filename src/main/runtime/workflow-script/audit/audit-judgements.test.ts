import { describe, expect, it, vi } from 'vitest'
import { JEV_MODEL } from '../../../../shared/jev-confidence'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import {
  observeAuditJudgements,
  type AuditJudgementObservation,
  type AuditJudgementOptions,
  type AuditJudgementRequest
} from './audit-judgements'

function request(): AuditJudgementRequest {
  return {
    callId: 'audit/rank/1',
    findings: ['private-finding-a', 'private-finding-b'].map((id) => ({
      id,
      title: 'Sal repeats setup',
      description: 'Sal repeats account setup for each task.',
      evidence: [{ sourceId: 'private-source', quote: 'Private quote never sent.' }],
      impact: 4,
      proposedFix: 'Private suggested remedy never sent.'
    })),
    pairs: [{ kind: 'duplicate', aId: 'private-finding-a', bId: 'private-finding-b' }],
    verifiedSourceIds: ['private-source']
  }
}

function answered(input: DecisionRequest): DecisionResult {
  return {
    provider: 'typesafe',
    model: JEV_MODEL,
    usage: { inputTokens: 24, outputTokens: 6 },
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([id, question]) => [
        id,
        question.type === 'score'
          ? {
              type: 'score',
              score: 4,
              confidence: 1,
              legend: Object.fromEntries(
                question.criteria.map((value, index) => [String(index), value])
              ),
              probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 }
            }
          : { type: 'noul', noul: 0.99 }
      ])
    )
  }
}

function setup() {
  const observations: AuditJudgementObservation[] = []
  const evaluate = vi.fn(async (input: DecisionRequest) => answered(input))
  const options: AuditJudgementOptions = {
    record: (observation) => {
      observations.push(observation)
    },
    redact: (value) => value.replaceAll('Sal', '[person]'),
    credential: async () => 'test-key',
    environment: {},
    evaluate
  }
  return { observations, evaluate, options }
}

describe('audit JEV shadow adapter', () => {
  it('batches pinned Score and Noul questions over minimum redacted facts', async () => {
    const { observations, evaluate, options } = setup()
    const result = await observeAuditJudgements(request(), options)
    expect(evaluate).toHaveBeenCalledTimes(1)
    const [input] = evaluate.mock.calls[0]
    expect(input.model).toBe('jev-1.13.0')
    expect(Object.keys(input.questions)).toHaveLength(6)
    expect(input.questions.rank_0.type).toBe('score')
    expect(input.questions.pair_0.type).toBe('noul')
    expect(JSON.stringify(input.state)).not.toMatch(/Sal|private-|Private/)
    expect(JSON.stringify(input.state)).toContain('[person]')
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'uncalibrated',
      route: 'generative',
      model: JEV_MODEL
    })
    expect(result.stateHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.predictions.pair_0).toEqual({ type: 'noul', noul: 0.99 })
    expect(JSON.stringify(result.predictions)).not.toContain('confidence')
    expect(observations).toEqual([result])
  })

  it('requires redaction and verified evidence before calling JEV', async () => {
    const { observations, evaluate, options } = setup()
    await observeAuditJudgements(request(), { ...options, redact: undefined })
    await observeAuditJudgements({ ...request(), verifiedSourceIds: [] }, options)
    expect(evaluate).not.toHaveBeenCalled()
    expect(observations.map(({ reason }) => reason)).toEqual([
      'missing-redaction',
      'unverified-evidence'
    ])
  })

  it('keeps disabled or failed inference on the generative route, without retry', async () => {
    const { evaluate, options } = setup()
    const disabled = await observeAuditJudgements(request(), {
      ...options,
      environment: { JEV_DECISIONS_DISABLED: '1' }
    })
    expect(disabled.reason).toBe('unavailable')
    expect(evaluate).not.toHaveBeenCalled()
    evaluate.mockRejectedValueOnce(new Error('provider failed'))
    const unavailable = await observeAuditJudgements(request(), options)
    expect(unavailable).toMatchObject({ reason: 'unavailable', route: 'generative' })
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('voids missing answers and a changed model, retaining missing ids', async () => {
    const { evaluate, options } = setup()
    evaluate.mockImplementationOnce(async (input) => {
      const result = answered(input)
      delete result.answers.pair_0
      return result
    })
    const missing = await observeAuditJudgements(request(), options)
    expect(missing).toMatchObject({
      status: 'voided',
      reason: 'invalid-response',
      missingQuestionIds: ['pair_0'],
      predictions: {}
    })
    evaluate.mockImplementationOnce(async (input) => ({ ...answered(input), model: 'jev-latest' }))
    expect((await observeAuditJudgements(request(), options)).status).toBe('voided')
  })

  it('rejects unknown pairs and oversized batches before inference', async () => {
    const { evaluate, options } = setup()
    const invalid = await observeAuditJudgements(
      { ...request(), pairs: [{ kind: 'agreement', aId: 'missing', bId: 'private-finding-b' }] },
      options
    )
    expect(invalid.reason).toBe('invalid-input')
    const oversized = await observeAuditJudgements(
      { ...request(), pairs: Array.from({ length: 33 }, () => request().pairs[0]) },
      options
    )
    expect(oversized.reason).toBe('invalid-input')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('propagates ledger failures rather than claiming an observation was recorded', async () => {
    const { options } = setup()
    await expect(
      observeAuditJudgements(request(), {
        ...options,
        record: () => {
          throw new Error('Disk full')
        }
      })
    ).rejects.toThrow('Disk full')
  })
})
