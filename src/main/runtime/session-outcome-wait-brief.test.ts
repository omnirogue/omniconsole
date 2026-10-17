import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import { sessionOutcomeWaitBrief } from './session-outcome-wait-brief'
import { nextOutcomeWaitRequests } from '../../shared/next-outcome-wait-request'

const waited: SessionOutcome = {
  id: 'wait',
  title: 'Uma approves',
  finish: 'complete',
  dependsOn: [],
  conditions: [
    {
      id: 'uma',
      kind: 'event',
      label: 'Uma approves on Slack',
      target: 'Uma approves on Slack',
      event: { source: 'slack', match: 'approve', personId: 'emp_uma', personName: 'Uma' }
    }
  ],
  actions: [],
  revision: 1,
  status: 'satisfied',
  evidence: [
    {
      id: 'e1',
      outcomeId: 'wait',
      conditionId: 'uma',
      outcomeRevision: 1,
      conditionKey: 'k',
      kind: 'event',
      target: 'Uma approves on Slack',
      receipt: 'event:slack:https://slack.test/p1@2026-09-24T16:00:00.000Z:emp_uma',
      verifiedAt: 1,
      verifier: 'execution-host'
    }
  ],
  waits: [
    {
      conditionId: 'uma',
      status: 'met',
      checkedAt: 1,
      excerpt: 'approved, go ahead',
      link: 'https://slack.test/p1',
      at: Date.parse('2026-09-24T16:00:00Z')
    }
  ]
}
const action = {
  id: 'upgrade',
  instruction: "upgrade Iris's account",
  conditionIds: ['done'],
  authority: 'existing-user-authority' as const,
  agent: 'claude' as const,
  route: 'same-session' as const
}
const next: SessionOutcome = {
  id: 'next',
  title: 'Upgrade',
  finish: 'complete',
  dependsOn: ['wait'],
  conditions: [{ id: 'done', kind: 'session', target: 'tab-1:leaf-1' }],
  actions: [action],
  revision: 1,
  status: 'pending',
  evidence: []
}

describe('sessionOutcomeWaitBrief', () => {
  it('hands the conversation the receipts and the person’s own next step', () => {
    const chain = { outcomeSet: { outcomes: [waited, next] } } as unknown as SessionChain
    const brief = sessionOutcomeWaitBrief(chain, action)
    expect(brief).toContain('has cleared')
    expect(brief).toContain(
      '- Uma approves on Slack at 2026-09-24T16:00:00.000Z — "approved, go ahead" (https://slack.test/p1)'
    )
    expect(brief).toContain("> upgrade Iris's account")
    // The delivered turn is the conversation's newest prompt: it must never file a wait again.
    expect(nextOutcomeWaitRequests(brief)).toEqual([])
    expect(
      nextOutcomeWaitRequests(
        sessionOutcomeWaitBrief(chain, {
          ...action,
          instruction: 'Wait for Uma to approve on Slack, then merge'
        })
      )
    ).toEqual([])
  })
})
