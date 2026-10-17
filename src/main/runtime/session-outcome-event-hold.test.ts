import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import { sessionOutcomeEventHold, sessionOutcomeEventWake } from './session-outcome-event-hold'

const person = (id: string, name: string) => ({
  id,
  kind: 'event' as const,
  target: `${name} approves on Slack`,
  event: {
    source: 'slack' as const,
    match: 'approve' as const,
    personId: `emp_${id}`,
    personName: name,
    ref: 'slack:D1:1',
    since: '2026-09-24T15:00:00.000Z'
  }
})

function outcome(waits: SessionOutcome['waits'] = []): SessionOutcome {
  return {
    id: 'o1',
    title: 'Wait for approvals',
    finish: 'complete',
    dependsOn: [],
    conditions: [person('uma', 'Uma'), person('iris', 'Iris')],
    actions: [],
    revision: 1,
    status: 'blocked',
    evidence: [],
    waits
  }
}
const chain = { sourcePaneKey: 'tab-1:leaf-1' } as SessionChain

describe('sessionOutcomeEventHold', () => {
  it('names who each wait is on and marks what arrived', () => {
    expect(sessionOutcomeEventWake(outcome(), new Set(['uma']))).toBe('Uma ✓, Iris ○ on Slack')
    expect(sessionOutcomeEventHold(chain, outcome(), new Set(['uma']))).toMatchObject({
      block: { class: 'waiting', code: 'event-wait', wake: 'Uma ✓, Iris ○ on Slack' },
      attention: []
    })
  })

  it('says a wait nobody can check is not scheduled', () => {
    const held = sessionOutcomeEventHold(
      chain,
      outcome([
        {
          conditionId: 'iris',
          status: 'unavailable',
          checkedAt: 1,
          reason: 'omnios does not serve wait facts yet.'
        }
      ]),
      new Set()
    )
    expect(held?.block).toEqual({
      class: 'waiting',
      code: 'event-wait-unavailable',
      wake: 'Follow-up not scheduled: omnios does not serve wait facts yet.'
    })
  })

  it('asks the owner when an answer is not a yes', () => {
    const held = sessionOutcomeEventHold(
      chain,
      outcome([
        { conditionId: 'iris', status: 'needs_you', checkedAt: 1, excerpt: 'not yet, tomorrow' }
      ]),
      new Set(['uma'])
    )
    expect(held?.block).toEqual({ class: 'attention', code: 'event-wait-needs-you' })
    expect(held?.attention).toHaveLength(1)
    expect(held?.attention[0]).toMatchObject({
      kind: 'decision',
      recipient: { type: 'owner' },
      scope: { outcomeId: 'o1', conditionId: 'iris' },
      ask: 'Iris replied on Slack: "not yet, tomorrow". Keep waiting, continue anyway, or cancel?'
    })
  })
})
