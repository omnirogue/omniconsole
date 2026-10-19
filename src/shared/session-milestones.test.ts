import { describe, expect, it } from 'vitest'
import { deployTargetLabel, sessionMilestones, sessionMilestonesDone } from './session-milestones'
import type { SessionPullRequestFacts } from './session-pull-request-facts'

function pr(
  number: number,
  baseBranch: string,
  overrides: Partial<SessionPullRequestFacts> = {}
): SessionPullRequestFacts {
  return {
    owner: 'omnirogue',
    repo: 'omnirogue',
    number,
    title: `PR ${number}`,
    url: `https://github.com/omnirogue/omnirogue/pull/${number}`,
    state: 'draft',
    approved: false,
    checks: 'success',
    failingChecks: 0,
    baseBranch,
    mergeCommit: null,
    mergedAt: null,
    settledAt: null,
    deploy: { workflows: ['Deploy'], status: null, url: null },
    ...overrides
  }
}

function merged(
  number: number,
  baseBranch: string,
  status: SessionPullRequestFacts['deploy']['status']
): SessionPullRequestFacts {
  return pr(number, baseBranch, {
    state: 'merged',
    mergeCommit: 'abc1234',
    mergedAt: 1,
    settledAt: 1,
    deploy: { workflows: ['Deploy'], status, url: `https://ci/${number}` }
  })
}

function summary(prs: SessionPullRequestFacts[], approvedByYou?: ReadonlySet<string>) {
  return sessionMilestones(prs, approvedByYou).map((milestone) => [
    milestone.kind === 'live' ? `live:${milestone.target}` : milestone.kind,
    milestone.status
  ])
}

describe('sessionMilestones', () => {
  it('reads the 22 Sep session: four drafts built, two failing, nothing approved or live', () => {
    const prs = [
      pr(1002, 'prod-omnirogue'),
      pr(1003, 'prod-betacorp'),
      pr(1007, 'prod-omnirogue', { checks: 'failure', failingChecks: 3 }),
      pr(1008, 'prod-betacorp', { checks: 'failure', failingChecks: 1 })
    ]
    const milestones = sessionMilestones(prs)
    expect(summary(prs)).toEqual([
      ['built', 'done'],
      ['checks', 'fail'],
      ['approved', 'todo'],
      ['live:OmniRogue', 'todo'],
      ['live:BetaCorp', 'todo']
    ])
    expect(milestones[0]).toMatchObject({ drafts: 4, pullRequests: [1002, 1003, 1007, 1008] })
    expect(milestones[1]).toMatchObject({ pullRequests: [1007, 1008] })
  })

  it('asks the person to approve only once PRs are ready and green', () => {
    const ready = [pr(1, 'prod-omnirogue', { state: 'open' })]
    expect(summary(ready)).toContainEqual(['approved', 'you'])
    expect(summary([pr(1, 'prod-omnirogue', { state: 'open', checks: 'pending' })])).toEqual([
      ['built', 'done'],
      ['checks', 'now'],
      ['approved', 'todo'],
      ['live:OmniRogue', 'todo']
    ])
    expect(summary(ready, new Set(['omnirogue/omnirogue#1']))).toContainEqual([
      'approved',
      'done'
    ])
    expect(summary([pr(1, 'prod-omnirogue', { state: 'open', approved: true })])).toContainEqual([
      'approved',
      'done'
    ])
  })

  it('turns every row green once each brand’s deploy carries the merge', () => {
    const milestones = sessionMilestones([
      merged(1, 'prod-omnirogue', 'success'),
      merged(2, 'prod-betacorp', 'success')
    ])
    expect(milestones.map((milestone) => milestone.status)).toEqual([
      'done',
      'done',
      'done',
      'done'
    ])
    expect(sessionMilestonesDone(milestones)).toBe(true)
  })

  it('shows a deploy in flight as now, a failed one as fail, and a partial one as some live', () => {
    expect(summary([merged(1, 'prod-betacorp', 'running')])).toContainEqual([
      'live:BetaCorp',
      'now'
    ])
    expect(summary([merged(1, 'prod-betacorp', 'waiting')])).toContainEqual([
      'live:BetaCorp',
      'now'
    ])
    const failed = sessionMilestones([merged(1, 'prod-betacorp', 'failure')])
    expect(failed.at(-1)).toMatchObject({ status: 'fail', url: 'https://ci/1' })
    const partial = sessionMilestones([
      merged(1, 'prod-omnirogue', 'success'),
      pr(2, 'prod-omnirogue', { state: 'open' })
    ])
    expect(partial.at(-1)).toMatchObject({ status: 'now', live: 1, total: 2 })
    expect(sessionMilestonesDone(partial)).toBe(false)
  })

  it('gives PRs into a branch that deploys nowhere one Merged row', () => {
    const undeployed = { workflows: [], status: null, url: null }
    expect(
      summary([
        pr(5, 'main-next', { state: 'merged', deploy: undeployed }),
        pr(6, 'main-next', { state: 'open', deploy: undeployed })
      ])
    ).toEqual([
      ['built', 'done'],
      ['approved', 'you'],
      ['merged', 'todo']
    ])
  })

  it('ignores closed PRs and has no milestones without an active one', () => {
    expect(sessionMilestones([pr(9, 'prod-omnirogue', { state: 'closed' })])).toEqual([])
    expect(sessionMilestonesDone([])).toBe(false)
  })
})

describe('deployTargetLabel', () => {
  it('names the brand behind a deploy branch', () => {
    expect(deployTargetLabel('prod-omnirogue')).toBe('OmniRogue')
    expect(deployTargetLabel('prod-betacorp')).toBe('BetaCorp')
    expect(deployTargetLabel('main')).toBe('main')
  })
})
