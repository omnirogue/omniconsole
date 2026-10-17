import { describe, expect, it } from 'vitest'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { GraphOutcome } from './graph/graph-plan-types'
import { SEAT_RULES } from './graph/graph-seat-substitution'
import { graphSeatOutcomes } from './local-workflow-graph-seat-outcomes'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'

const seat = (id: string, agent: 'claude' | 'codex', accountId: string) =>
  ({
    id,
    agent,
    accountId,
    model: `${agent}-model`,
    effort: null,
    lineage: 'openai',
    policyRevision: 'p'
  }) as ResolvedLocalWorkflowSeat

const snapshot = (seatRules?: number) =>
  ({
    seats: [seat('codex', 'codex', 'system:codex'), seat('claude', 'claude', 'system:claude')],
    graph: {
      spec: { title: 'x', steps: [] },
      agentSeats: { find: ['codex', 'claude'] },
      ...(seatRules
        ? { seatRules, spareSeats: [seat('codex@managed:m1', 'codex', 'managed:m1')] }
        : {})
    }
  }) as unknown as LocalWorkflowHostSnapshot & {
    graph: NonNullable<LocalWorkflowHostSnapshot['graph']>
  }

const record = (callId: string) => ({
  call_id: callId,
  result_json: null,
  result_digest: null,
  quarantined: 0
})
const noLaunch = (callId: string, ordinal: number) => ({
  id: `${callId}-${ordinal}`,
  call_id: callId,
  ordinal,
  state: 'failed',
  receipt_json: JSON.stringify({
    noLaunch: true,
    reason: 'The selected Codex account is unavailable.'
  })
})

describe('the view of calls moved after a launch failure', () => {
  const attempts = [noLaunch('find/a0', 1), noLaunch('find/a0', 2)]

  it('shows the planned call with its substitute’s answer, and the move', () => {
    const outcomes = graphSeatOutcomes({
      snapshot: snapshot(SEAT_RULES),
      records: [record('find/a0'), record('find/a0~codex@managed:m1')],
      attempts,
      results: new Map([['find/a0~codex@managed:m1', { markdown: 'found' }]]),
      outcomes: new Map<string, GraphOutcome>([
        ['find/a0', { failed: true }],
        ['find/a0~codex@managed:m1', { value: { markdown: 'found' } }]
      ])
    })
    expect([...outcomes]).toEqual([
      [
        'find/a0',
        {
          value: { markdown: 'found' },
          substitute: {
            seatId: 'codex@managed:m1',
            callId: 'find/a0~codex@managed:m1',
            from: 'Codex',
            to: 'another Codex account',
            reason: 'The selected Codex account is unavailable.'
          }
        }
      ]
    ])
  })

  it('waits while the substitute runs, and marks a call no seat took as lost', () => {
    const running = graphSeatOutcomes({
      snapshot: snapshot(SEAT_RULES),
      records: [record('find/a0~codex@managed:m1'), record('find/a0')],
      attempts,
      results: new Map(),
      outcomes: new Map<string, GraphOutcome>([['find/a0', { failed: true }]])
    })
    expect(running.has('find/a0')).toBe(false)
    const lost = graphSeatOutcomes({
      snapshot: snapshot(SEAT_RULES),
      records: [record('find/a0')],
      attempts,
      results: new Map(),
      outcomes: new Map<string, GraphOutcome>([['find/a0', { failed: true }]])
    })
    expect(lost.get('find/a0')).toEqual({
      failed: true,
      lost: 'The selected Codex account is unavailable.'
    })
  })

  it('leaves a run admitted before seat rules as it was', () => {
    const before = new Map<string, GraphOutcome>([['find/a0', { failed: true }]])
    expect(
      graphSeatOutcomes({
        snapshot: snapshot(),
        records: [record('find/a0')],
        attempts,
        results: new Map(),
        outcomes: new Map(before)
      })
    ).toEqual(before)
  })
})
