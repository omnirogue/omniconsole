import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { WORK_PLAN_PROPOSE_METHODS } from './work-plan-propose'

function method(name: string) {
  const found = WORK_PLAN_PROPOSE_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  return found
}

const ctx = {
  usableAgents: [
    { agent: 'claude', models: [] },
    { agent: 'codex', models: [] }
  ],
  source: null,
  placement: 'local',
  accountCatalogue: [],
  commitSource: 'proposer',
  capabilities: { sameConversationRoute: false }
}

describe('workPlan.propose RPC', () => {
  it('is registered and its params schema accepts the shape the composer sends', () => {
    const found = method('workPlan.propose')
    const parsed = found.params?.parse({
      text: '2 researchers then me',
      ctx,
      outcome: undefined,
      existingChain: undefined
    })
    expect(parsed).toMatchObject({ text: '2 researchers then me' })
  })

  it('rejects unknown params fields (strict schema)', () => {
    const found = method('workPlan.propose')
    expect(() => found.params?.parse({ text: 'x', ctx, extra: true })).toThrow()
  })

  it('returns a plan for a described workflow', async () => {
    const found = method('workPlan.propose')
    const result = await found.handler(
      { text: '2 researchers then me', ctx },
      {} as unknown as { runtime: OrcaRuntimeService }
    )
    expect(result).toMatchObject({})
    expect((result as { plan: unknown }).plan).not.toBeNull()
  })

  it('never throws to the caller for a question', async () => {
    const found = method('workPlan.propose')
    const result = await found.handler(
      { text: 'What is the recommended next action after a Best-of-N judge?', ctx },
      {} as unknown as { runtime: OrcaRuntimeService }
    )
    expect(result).toMatchObject({ plan: null, reason: 'no-pursuit' })
  })

  it('never throws to the caller for a malformed ctx', async () => {
    const found = method('workPlan.propose')
    const result = await found.handler(
      { text: '2 researchers then me', ctx: { not: 'a valid ctx' } },
      {} as unknown as { runtime: OrcaRuntimeService }
    )
    expect(result).toMatchObject({ plan: null, reason: 'provider-unavailable' })
  })
})
