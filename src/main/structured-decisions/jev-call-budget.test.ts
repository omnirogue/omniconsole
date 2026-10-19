import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { jevDecide } from './jev-rank'
import { jevCallBudget, type JevCallBudget } from './jev-call-budget'

const key = async () => 'k'.repeat(24)
const decision = {
  capability: 'workflow.judge',
  state: { response: 'Tagline 1' },
  questions: {}
} as unknown as DecisionRequest
const answered: DecisionResult = {
  provider: 'typesafe',
  model: 'jev-1.13.0',
  answers: {},
  usage: { inputTokens: 900, outputTokens: 40 },
  requestId: 'jev-req-1'
}

function budget(refuse?: string) {
  const calls: { admit: unknown[]; settle: unknown[]; unknown: string[] } = {
    admit: [],
    settle: [],
    unknown: []
  }
  const gate: JevCallBudget = {
    admitBounded: async (input) => {
      calls.admit.push(input)
      if (refuse) {
        throw new Error(`The budget refused this call (${refuse}). Nothing was sent.`)
      }
      return { reservedUsd: 0.01 }
    },
    settle: async (receipt) => {
      calls.settle.push(receipt)
    },
    unknown: async (id) => {
      calls.unknown.push(id)
    }
  }
  return { gate, calls }
}

describe('JEV ballots inside a budgeted workflow', () => {
  it('admits each ballot before asking TypeSafe and settles its tokens', async () => {
    const evaluate = vi.fn(async () => answered)
    const { gate, calls } = budget()
    const result = await jevCallBudget.run(gate, () =>
      jevDecide(decision, { evaluate, credential: key, environment: {} })
    )
    expect(result).toBe(answered)
    expect(calls.admit).toMatchObject([
      { stage: 'jev', provider: 'typesafe', model: 'jev', maxOutputTokens: 2_048 }
    ])
    expect(calls.settle).toMatchObject([
      {
        outcome: 'ok',
        input_tokens: 900,
        output_tokens: 40,
        provider_request_id: 'jev-req-1',
        estimate_from_tokens: true
      }
    ])
  })

  it('a refused ballot never reaches TypeSafe', async () => {
    const evaluate = vi.fn(async () => answered)
    const { gate } = budget('budget_exhausted')
    const result = await jevCallBudget.run(gate, () =>
      jevDecide(decision, { evaluate, credential: key, environment: {} })
    )
    expect(result).toEqual({ failed: expect.stringContaining('budget_exhausted') })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('a failed ballot keeps its reservation; outside a budgeted run nothing changes', async () => {
    const { gate, calls } = budget()
    await jevCallBudget.run(gate, () =>
      jevDecide(decision, {
        evaluate: vi.fn(async () => {
          throw new Error('socket hang up')
        }),
        credential: key,
        environment: {}
      })
    )
    expect(calls.unknown).toHaveLength(1)
    const evaluate = vi.fn(async () => answered)
    expect(await jevDecide(decision, { evaluate, credential: key, environment: {} })).toBe(answered)
    expect(calls.admit).toHaveLength(1)
  })
})
