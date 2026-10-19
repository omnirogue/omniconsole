import { describe, expect, it } from 'vitest'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { resolveNextOutcomeWaits } from '../../shared/next-outcome-wait-request'
import {
  requireApprovalBeforeDependents,
  stampSessionWaitPeople
} from './session-outcome-inferred-waits'

const commit = (outcomes: SessionOutcomeCommit['outcomes']): SessionOutcomeCommit =>
  ({ source: 'ai', expectedRevision: 0, outcomes }) as unknown as SessionOutcomeCommit

describe('inferred waits', () => {
  it('names a wait’s person from the roster, never from the agent', () => {
    const waits = resolveNextOutcomeWaits('Wait for Uma to approve on Slack', [
      { id: 'emp_uma', name: 'Uma Demir' }
    ])
    const stamped = stampSessionWaitPeople(
      commit([
        {
          id: 'o',
          title: 'wait',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [
            {
              id: 'c',
              kind: 'event',
              target: 'x',
              event: { source: 'slack', match: 'approve', personId: 'emp_uma', personName: 'Boss' }
            }
          ]
        }
      ]),
      waits
    )
    expect(stamped.outcomes[0]!.conditions[0]!.event?.personName).toBe('Uma Demir')
  })

  it('makes a person review that other work waits behind approve-only', () => {
    const review = { id: 'r', kind: 'review' as const, target: 'emp_uma', recipientId: 'emp_uma' }
    const out = requireApprovalBeforeDependents(
      commit([
        { id: 'a', title: 'a', finish: 'human-handoff', dependsOn: [], actions: [], conditions: [review] },
        { id: 'b', title: 'b', finish: 'complete', dependsOn: ['a'], actions: [], conditions: [] as never },
        { id: 'c', title: 'c', finish: 'human-handoff', dependsOn: [], actions: [], conditions: [review] }
      ]),
      undefined
    )
    expect(out.outcomes[0]!.conditions[0]!.require).toBe('approve')
    expect(out.outcomes[2]!.conditions[0]!.require).toBeUndefined()
  })
})
