import { describe, expect, it } from 'vitest'
import type { SessionChain } from './session-chain-types'
import {
  sessionOutcomeWaitsSummary,
  sessionWaitsFingerprint
} from './session-outcome-waits-summary'

function chain(overrides: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'c',
    state: 'waiting',
    outcomeSet: {
      outcomes: [
        {
          id: 'wait',
          revision: 1,
          conditions: [
            {
              id: 'uma',
              kind: 'event',
              label: 'Uma approves on Slack',
              target: 'Uma approves on Slack',
              event: { source: 'slack', match: 'approve', personId: 'emp_uma' }
            },
            {
              id: 'pr',
              kind: 'event',
              target: 'PR 12 merges',
              event: { source: 'github', match: 'merged', ref: 'https://github.com/o/r/pull/12' }
            },
            { id: 'done', kind: 'session', target: 'pane' }
          ],
          evidence: [{ conditionId: 'pr', outcomeRevision: 1 }],
          waits: [
            {
              conditionId: 'uma',
              status: 'needs_you',
              checkedAt: Date.parse('2026-09-24T20:00:00Z'),
              link: 'https://slack.test/p1'
            }
          ]
        }
      ]
    },
    ...overrides
  } as unknown as SessionChain
}

describe('sessionOutcomeWaitsSummary', () => {
  it('lists each wait for omnios with who, where, status and when it was checked', () => {
    const now = Date.parse('2026-09-24T21:00:00Z')
    expect(sessionOutcomeWaitsSummary(chain(), now)).toEqual([
      {
        label: 'Uma approves on Slack',
        source: 'slack',
        status: 'needs_you',
        checked_at: '2026-09-24T20:00:00.000Z',
        person_id: 'emp_uma',
        link: 'https://slack.test/p1'
      },
      {
        label: 'PR 12 merges',
        source: 'github',
        status: 'met',
        checked_at: '2026-09-24T21:00:00.000Z',
        link: 'https://github.com/o/r/pull/12'
      }
    ])
  })

  it('clears the list when the plan is cancelled, and ignores check times when comparing', () => {
    expect(sessionOutcomeWaitsSummary(chain({ state: 'cancelled' }))).toEqual([])
    const early = sessionOutcomeWaitsSummary(chain(), 1)
    const late = sessionOutcomeWaitsSummary(chain(), 2)
    expect(sessionWaitsFingerprint(early)).toBe(sessionWaitsFingerprint(late))
  })
})
