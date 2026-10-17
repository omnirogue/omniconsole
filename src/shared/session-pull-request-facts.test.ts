import { describe, expect, it } from 'vitest'
import {
  deployCandidates,
  deployRunStatus,
  isSessionPullRequestRef,
  parseSessionDeployRuns,
  parseSessionPullRequestView,
  sessionPullRequestKey
} from './session-pull-request-facts'

const REF = { owner: 'omnirogue', repo: 'omnirogue', number: 1008 }

describe('parseSessionPullRequestView', () => {
  it('reads state, approval, checks and the merge', () => {
    expect(
      parseSessionPullRequestView(REF, {
        title: 'Align BetaCorp catalog options',
        url: 'https://github.com/omnirogue/omnirogue/pull/1008',
        state: 'MERGED',
        isDraft: false,
        reviewDecision: 'APPROVED',
        statusCheckRollup: [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
          { status: 'COMPLETED', conclusion: 'FAILURE' },
          { state: 'ERROR' }
        ],
        baseRefName: 'prod-betacorp',
        mergeCommit: { oid: 'abc123def' },
        mergedAt: '2026-09-22T12:00:00Z'
      })
    ).toEqual({
      ...REF,
      title: 'Align BetaCorp catalog options',
      url: 'https://github.com/omnirogue/omnirogue/pull/1008',
      state: 'merged',
      approved: true,
      reviewDecision: 'approved',
      checks: 'failure',
      failingChecks: 2,
      baseBranch: 'prod-betacorp',
      mergeCommit: 'abc123def',
      mergedAt: Date.parse('2026-09-22T12:00:00Z'),
      settledAt: Date.parse('2026-09-22T12:00:00Z'),
      headCommit: null
    })
  })

  it('tells a draft from an open PR and tolerates missing fields', () => {
    expect(parseSessionPullRequestView(REF, { state: 'OPEN', isDraft: true })).toMatchObject({
      state: 'draft',
      approved: false,
      checks: 'neutral',
      mergeCommit: null,
      mergedAt: null,
      url: 'https://github.com/omnirogue/omnirogue/pull/1008'
    })
    expect(parseSessionPullRequestView(REF, { state: 'OPEN' })?.state).toBe('open')
    expect(
      parseSessionPullRequestView(REF, { state: 'CLOSED', closedAt: '2026-09-21T08:00:00Z' })
    ).toMatchObject({ state: 'closed', settledAt: Date.parse('2026-09-21T08:00:00Z') })
    expect(parseSessionPullRequestView(REF, null)).toBeNull()
  })
})

describe('deploy runs', () => {
  const runs = parseSessionDeployRuns([
    {
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'A1',
      created_at: '2026-09-22T12:05:00Z'
    },
    {
      name: 'Deploy Betacorp',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'B2',
      html_url: 'https://ci/2',
      created_at: '2026-09-22T11:00:00Z'
    },
    {
      name: 'Deploy Betacorp',
      status: 'in_progress',
      conclusion: null,
      head_sha: 'C3',
      html_url: 'https://ci/3',
      created_at: '2026-09-22T12:10:00Z'
    }
  ])

  it('keeps deploy workflows only, newest first, with lower-case heads', () => {
    expect(runs.map((run) => run.headSha)).toEqual(['c3', 'b2'])
  })

  it('offers only runs that started after the merge as its carriers', () => {
    expect(
      deployCandidates(runs, Date.parse('2026-09-22T12:00:00Z')).map((run) => run.headSha)
    ).toEqual(['c3'])
  })

  it('reads a run as running, success or failure', () => {
    expect(runs.map(deployRunStatus)).toEqual(['running', 'failure'])
  })
})

describe('references', () => {
  it('accepts only a well-formed owner, repo and positive number', () => {
    expect(isSessionPullRequestRef(REF)).toBe(true)
    expect(isSessionPullRequestRef({ ...REF, owner: '../x' })).toBe(false)
    expect(isSessionPullRequestRef({ ...REF, repo: '..' })).toBe(false)
    expect(isSessionPullRequestRef({ ...REF, number: 0 })).toBe(false)
    expect(isSessionPullRequestRef('x')).toBe(false)
    expect(sessionPullRequestKey(REF)).toBe('omnirogue/omnirogue#1008')
  })
})
