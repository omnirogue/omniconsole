import { describe, expect, it } from 'vitest'
import { cleanPullRequestTitle, sessionGoalGroups } from './session-goal-groups'
import { sessionPullRequestKey, type SessionPullRequestFacts } from './session-pull-request-facts'
import type { SessionPullRequestMention } from './session-pull-request-refs'

const HOUR = 3_600_000

function facts(
  number: number,
  title: string,
  overrides: Partial<SessionPullRequestFacts> = {}
): SessionPullRequestFacts {
  return {
    owner: 'omnirogue',
    repo: 'omnirogue',
    number,
    title,
    url: `https://github.com/omnirogue/omnirogue/pull/${number}`,
    state: 'draft',
    approved: false,
    checks: 'success',
    failingChecks: 0,
    baseBranch: number % 2 === 0 ? 'prod-omnirogue' : 'prod-betacorp',
    mergeCommit: null,
    mergedAt: null,
    settledAt: null,
    deploy: { workflows: ['Deploy'], status: null, url: null },
    ...overrides
  }
}

function shipped(number: number, title: string, at: number): SessionPullRequestFacts {
  return facts(number, title, {
    state: 'merged',
    mergeCommit: 'abc1234',
    mergedAt: at,
    settledAt: at,
    deploy: { workflows: ['Deploy'], status: 'success', url: null }
  })
}

function mention(number: number, firstAt: number, order: number): SessionPullRequestMention {
  return {
    owner: 'omnirogue',
    repo: 'omnirogue',
    number,
    firstOrder: order,
    lastOrder: order,
    firstAt
  }
}

function byKey(...prs: SessionPullRequestFacts[]): Map<string, SessionPullRequestFacts> {
  return new Map(prs.map((pr) => [sessionPullRequestKey(pr), pr]))
}

describe('cleanPullRequestTitle', () => {
  it.each([
    ['fix(create): align OmniRogue catalog options', 'Align OmniRogue catalog options'],
    [
      'OmniRogue: combine generation settings in one popover',
      'Combine generation settings in one popover'
    ],
    ['feat!: unlimited toggle', 'Unlimited toggle'],
    ['Publish Unlimited Toggle Upgrade', 'Publish Unlimited Toggle Upgrade']
  ])('%s → %s', (raw, clean) => {
    expect(cleanPullRequestTitle(raw)).toBe(clean)
  })
})

describe('sessionGoalGroups', () => {
  it('closes a shipped goal and opens a new one for a PR named after it went live', () => {
    const groups = sessionGoalGroups(
      [mention(870, 1 * HOUR, 1), mention(871, 1 * HOUR, 2), mention(1002, 5 * HOUR, 3)],
      byKey(
        shipped(870, 'feat: publish unlimited toggle upgrade', 3 * HOUR),
        shipped(871, 'feat: publish unlimited toggle upgrade (BetaCorp)', 3 * HOUR),
        facts(1002, 'OmniRogue: combine generation settings in one popover')
      )
    )
    expect(groups.map((group) => [group.title, group.done])).toEqual([
      ['Publish unlimited toggle upgrade', true],
      ['Combine generation settings in one popover', false]
    ])
    expect(groups[0]?.pullRequests.map((pr) => pr.number)).toEqual([870, 871])
  })

  it('keeps PRs in one goal while an earlier one is still moving', () => {
    const groups = sessionGoalGroups(
      [mention(1, 1 * HOUR, 1), mention(2, 5 * HOUR, 2)],
      byKey(facts(1, 'feat: one'), facts(2, 'feat: two'))
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.pullRequests.map((pr) => pr.number)).toEqual([1, 2])
  })

  it('keeps a PR named before the last one settled in that goal', () => {
    const groups = sessionGoalGroups(
      [mention(1, 1 * HOUR, 1), mention(2, 2 * HOUR, 2)],
      byKey(shipped(1, 'feat: one', 3 * HOUR), facts(2, 'feat: two'))
    )
    expect(groups).toHaveLength(1)
  })

  it('skips PRs not read yet and drops a goal of closed PRs', () => {
    expect(sessionGoalGroups([mention(3, 1, 1)], byKey())).toEqual([])
    expect(
      sessionGoalGroups(
        [mention(4, 1, 1)],
        byKey(facts(4, 'feat: gone', { state: 'closed', settledAt: 2 }))
      )
    ).toEqual([])
  })

  it('counts the person’s own approval', () => {
    const [group] = sessionGoalGroups(
      [mention(6, 1, 1)],
      byKey(facts(6, 'feat: six')),
      new Set(['omnirogue/omnirogue#6'])
    )
    expect(group?.milestones.find((milestone) => milestone.kind === 'approved')?.status).toBe(
      'done'
    )
  })
})
