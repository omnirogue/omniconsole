import { describe, expect, it, vi } from 'vitest'
import type { NextStepDoneness } from '../../shared/next-step-doneness'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import type { DecisionRequest } from '../../shared/structured-decisions'
import type { NextStepJev } from '../next-steps/next-step-jev'
import {
  buildStewardAdvanceRequest,
  createStewardJev,
  readStewardAdvanceScore,
  STEWARD_ADVANCE_LEVELS,
  stewardDonenessOf,
  stewardDonenessVerdict
} from './steward-jev'

const step = {
  id: 's1',
  title: 'Add the migration',
  prompt: 'Add the migration for orders'
} as NextStepSuggestion
const source = { worktreeId: 'w', paneKey: 'p', kind: 'pty' as const }

function reading(resolved: number, remainingWork: number, extra: Partial<NextStepDoneness> = {}) {
  return stewardDonenessOf({
    resolved,
    remainingWork,
    roomToImprove: 0.5,
    verified: 0.5,
    unsure: true,
    turnKey: 't1',
    at: 1,
    ...extra
  })
}

describe('reading JEV for the steward', () => {
  it('judges only resolved and remaining work, so unverified finished work is still finished', () => {
    expect(stewardDonenessVerdict(reading(0.9, 0.1))).toBe('finished')
    expect(stewardDonenessVerdict(reading(0.1, 0.9))).toBe('work-left')
    expect(stewardDonenessVerdict(reading(0.5, 0.1))).toBe('unclear')
    expect(stewardDonenessVerdict(reading(0.9, 0.9))).toBe('unclear')
  })

  it('asks the advance question as one 0–4 score over the goal and the step', () => {
    const request = buildStewardAdvanceRequest('Fix the parser', step)
    expect(request.state).toEqual({
      goal: 'Fix the parser',
      step: 'Title: Add the migration\nPrompt: Add the migration for orders'
    })
    expect(request.questions.advances).toMatchObject({
      type: 'score',
      criteria: STEWARD_ADVANCE_LEVELS
    })
    expect(
      readStewardAdvanceScore({
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
        answers: {
          advances: { type: 'score', score: 3.4, legend: {}, probabilities: {}, confidence: 0.9 }
        }
      })
    ).toBe(3.4)
  })

  it('is off with JEV_DECISIONS_DISABLED, with doneness switched off, or with no JEV running', () => {
    const jev = { goalFor: vi.fn(), assessDoneness: vi.fn() } as unknown as NextStepJev
    const make = (env: NodeJS.ProcessEnv, doneness: boolean, running = true) =>
      createStewardJev({
        settings: () => ({ enabled: true, jev: { rank: true, risk: true, doneness } }),
        nextStepJev: () => (running ? jev : null),
        environment: env
      }).offReason()
    expect(make({}, true)).toBeNull()
    expect(make({ JEV_DECISIONS_DISABLED: '1' }, true)).toBe('JEV is turned off on this computer')
    expect(make({}, false)).toBe('JEV doneness readings are switched off in Settings')
    expect(make({}, true, false)).toBe('JEV is not running on this computer')
  })

  it('reads doneness through the shared per-turn reading, against the goal', async () => {
    const assessDoneness = vi.fn(async () => ({
      resolved: 0.95,
      remainingWork: 0.02,
      roomToImprove: 0.1,
      verified: 0.5,
      unsure: true,
      turnKey: 't1',
      at: 1
    }))
    const jev = {
      goalFor: vi.fn(async () => 'Fix the parser'),
      assessDoneness
    } as unknown as NextStepJev
    const steward = createStewardJev({
      settings: () => ({ enabled: true }),
      nextStepJev: () => jev,
      environment: {}
    })
    expect(await steward.doneness({ source, turnKey: 't1', reply: 'Done.' })).toEqual({
      turnKey: 't1',
      resolved: 0.95,
      remainingWork: 0.02,
      unsure: false
    })
    expect(assessDoneness).toHaveBeenCalledWith({
      conversation: source,
      turnKey: 't1',
      goal: 'Fix the parser',
      replyTail: 'Done.'
    })
  })

  it('asks the advance question once per step and turn, and nothing with JEV off', async () => {
    const evaluate = vi.fn(async (request: DecisionRequest) => ({
      provider: 'p',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 },
      answers: {
        advances: { type: 'score' as const, score: 4, legend: {}, probabilities: {}, confidence: 1 }
      },
      request
    }))
    const steward = createStewardJev({
      settings: () => ({ enabled: true }),
      nextStepJev: () => ({}) as NextStepJev,
      environment: {},
      jev: { evaluate, credential: async () => 'key', environment: {} }
    })
    expect(await steward.advances({ turnKey: 't1', goal: 'g', step })).toBe(4)
    expect(await steward.advances({ turnKey: 't1', goal: 'g', step })).toBe(4)
    expect(evaluate).toHaveBeenCalledTimes(1)
    const off = createStewardJev({
      settings: () => ({ enabled: true }),
      nextStepJev: () => ({}) as NextStepJev,
      environment: { JEV_DECISIONS_DISABLED: 'true' },
      jev: { evaluate, credential: async () => 'key', environment: {} }
    })
    expect(await off.advances({ turnKey: 't2', goal: 'g', step })).toBeNull()
    expect(evaluate).toHaveBeenCalledTimes(1)
  })
})
