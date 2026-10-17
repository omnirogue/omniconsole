import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import {
  installSessionOutcomePullRequestReader,
  installSessionOutcomeWaitFactsReader,
  verifySessionOutcomeEvent,
  type WaitFactsAnswer,
  type WaitFactsQuery
} from './session-outcome-event-evidence'

const NOW = Date.parse('2026-09-24T16:00:00Z')
const iso = (offset: number) => new Date(NOW + offset).toISOString()
const slack: SessionOutcomeCondition = {
  id: 'uma',
  kind: 'event',
  target: 'Uma approves on Slack',
  event: {
    source: 'slack',
    match: 'approve',
    personId: 'emp_uma',
    personName: 'Uma',
    ref: 'slack:D1:1727190000.1',
    since: iso(-60_000)
  }
}

let answer: WaitFactsAnswer
const facts = vi.fn(async (_query: WaitFactsQuery) => answer)

beforeEach(() => {
  facts.mockClear()
  installSessionOutcomeWaitFactsReader(facts)
})

describe('verifySessionOutcomeEvent', () => {
  it('latches a met fact only with the named person’s receipt', async () => {
    answer = {
      status: 'met',
      evidence: {
        at: iso(-1_000),
        by: { person_id: 'emp_uma', name: 'Uma' },
        link: 'https://slack.com/archives/D1/p1',
        excerpt: 'approve',
        kind: 'slack_reply'
      }
    }
    const result = await verifySessionOutcomeEvent(slack, undefined, NOW)
    expect(result).toMatchObject({
      verified: true,
      receipt: `event:slack:https://slack.com/archives/D1/p1@${iso(-1_000)}:emp_uma`,
      wait: { status: 'met', by: 'Uma', excerpt: 'approve', checkedAt: NOW }
    })
    expect(facts).toHaveBeenCalledWith({
      source: 'slack',
      personId: 'emp_uma',
      ref: 'slack:D1:1727190000.1',
      since: iso(-60_000),
      match: 'approve'
    })
    answer = { ...answer, evidence: { ...answer.evidence!, by: { person_id: 'emp_x', name: 'X' } } }
    expect(await verifySessionOutcomeEvent(slack, undefined, NOW)).toMatchObject({
      verified: false,
      wait: { status: 'unavailable' }
    })
  })

  it('carries needs-you and unavailable readings, never a silent wait', async () => {
    answer = { status: 'needs_you', reason: 'Uma asked for changes', evidence: undefined }
    expect(await verifySessionOutcomeEvent(slack, undefined, NOW)).toMatchObject({
      verified: false,
      wait: { status: 'needs_you', reason: 'Uma asked for changes' }
    })
    answer = { status: 'unavailable', reason: 'No Slack grant' }
    expect(await verifySessionOutcomeEvent(slack, undefined, NOW)).toMatchObject({
      verified: false,
      reason: 'Follow-up not scheduled: No Slack grant',
      wait: { status: 'unavailable' }
    })
    facts.mockRejectedValueOnce(new Error('offline'))
    expect(await verifySessionOutcomeEvent(slack, undefined, NOW)).toMatchObject({
      wait: { status: 'unavailable', reason: 'offline' }
    })
  })

  it('asks from the owner’s re-arm, not the original ask, after "keep waiting"', async () => {
    answer = { status: 'pending' }
    await verifySessionOutcomeEvent(
      slack,
      { conditionId: 'uma', status: 'pending', checkedAt: NOW, rearmedAt: NOW - 5_000 },
      NOW
    )
    expect(facts.mock.calls.at(-1)![0]).toMatchObject({
      since: new Date(NOW - 5_000).toISOString()
    })
  })

  it('turns a passed deadline into the owner’s decision unless they chose to keep waiting', async () => {
    answer = { status: 'pending' }
    const late: SessionOutcomeCondition = {
      ...slack,
      event: { ...slack.event!, deadline: iso(-1), onDeadline: 'ask-owner' }
    }
    expect(await verifySessionOutcomeEvent(late, undefined, NOW)).toMatchObject({
      wait: { status: 'needs_you', reason: expect.stringContaining('No answer from Uma by') }
    })
    expect(
      await verifySessionOutcomeEvent(
        late,
        { conditionId: 'uma', status: 'pending', checkedAt: NOW, rearmedAt: NOW },
        NOW
      )
    ).toMatchObject({ wait: { status: 'pending' } })
  })

  it('reads a time on the clock and a pull request from the forge', async () => {
    const time: SessionOutcomeCondition = {
      id: 't',
      kind: 'event',
      target: 'in 2 minutes',
      event: { source: 'time', match: 'at', at: iso(120_000) }
    }
    expect(await verifySessionOutcomeEvent(time, undefined, NOW)).toMatchObject({ verified: false })
    expect(await verifySessionOutcomeEvent(time, undefined, NOW + 120_000)).toMatchObject({
      verified: true,
      receipt: `time:${iso(120_000)}`
    })
    const url = 'https://github.com/omnirogue/omni-ide/pull/700'
    const pr = {
      owner: 'omnirogue',
      repo: 'omni-ide',
      number: 700,
      url,
      state: 'open' as const,
      approved: false,
      mergeCommit: null,
      mergedAt: null
    }
    const read = vi.fn(async () => pr as never)
    installSessionOutcomePullRequestReader(read)
    const merged: SessionOutcomeCondition = {
      id: 'pr',
      kind: 'event',
      target: 'PR 700 merges',
      event: { source: 'github', match: 'merged', ref: url }
    }
    expect(await verifySessionOutcomeEvent(merged, undefined, NOW)).toMatchObject({
      verified: false,
      wait: { status: 'pending', link: url }
    })
    Object.assign(pr, { state: 'merged', mergeCommit: 'abc1234', mergedAt: NOW - 1 })
    expect(await verifySessionOutcomeEvent(merged, undefined, NOW)).toMatchObject({
      verified: true,
      receipt: `github:${url}:merged@abc1234`
    })
    expect(read).toHaveBeenCalledWith({ owner: 'omnirogue', repo: 'omni-ide', number: 700 })
  })

  it('reads a Slack wait whose ask never went out as not scheduled, without asking omnios', async () => {
    const { ref: _ref, ...unasked } = slack.event!
    const result = await verifySessionOutcomeEvent({ ...slack, event: unasked }, undefined, NOW)
    expect(result).toMatchObject({
      verified: false,
      reason: expect.stringContaining('Follow-up not scheduled: No ask went out on Slack'),
      wait: { status: 'unavailable' }
    })
    expect(facts).not.toHaveBeenCalled()
  })
})
