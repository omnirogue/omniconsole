import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gh } = vi.hoisted(() => ({ gh: vi.fn() }))
vi.mock('./gh-utils', () => ({ ghExecFileAsync: gh }))

import {
  readSessionPullRequestFacts,
  resetSessionPullRequestFactsCacheForTest
} from './session-pull-request-facts'

const REF = { owner: 'omnirogue', repo: 'omnirogue', number: 1007 }
const MERGE = 'a'.repeat(40)
const LATER = 'b'.repeat(40)

function view(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 1007,
    title: 'fix(create): align OmniRogue catalog options',
    url: 'https://github.com/omnirogue/omnirogue/pull/1007',
    state: 'MERGED',
    isDraft: false,
    reviewDecision: '',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    baseRefName: 'prod-omnirogue',
    mergeCommit: { oid: MERGE },
    mergedAt: '2026-09-22T12:00:00Z',
    ...overrides
  })
}

function runs(...list: Record<string, unknown>[]): string {
  return JSON.stringify(list)
}

function deployRun(headSha: string, createdAt: string, conclusion: string | null = 'success') {
  return {
    name: 'Deploy to Production',
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    head_sha: headSha,
    html_url: `https://github.com/omnirogue/omnirogue/actions/runs/${headSha.slice(0, 4)}`,
    created_at: createdAt
  }
}

function answer(byCommand: (args: string[]) => string): void {
  gh.mockImplementation(async (args: string[]) => ({ stdout: byCommand(args), stderr: '' }))
}

beforeEach(() => {
  gh.mockReset()
  resetSessionPullRequestFactsCacheForTest()
})

describe('readSessionPullRequestFacts', () => {
  it('reads a merged PR as live once the deploy run on its base branch carries the merge', async () => {
    answer((args) =>
      args[0] === 'pr'
        ? view()
        : runs(
            { ...deployRun(MERGE, '2026-09-22T12:00:05Z'), name: 'CI' },
            deployRun(MERGE, '2026-09-22T12:00:05Z')
          )
    )
    const facts = await readSessionPullRequestFacts(REF)
    expect(facts).toMatchObject({
      state: 'merged',
      baseBranch: 'prod-omnirogue',
      deploy: { workflows: ['Deploy to Production'], status: 'success' }
    })
    expect(gh.mock.calls[0]?.[0]).toEqual([
      'pr',
      'view',
      '1007',
      '-R',
      'omnirogue/omnirogue',
      '--json',
      expect.any(String)
    ])
    expect(gh.mock.calls[1]?.[0]?.[1]).toBe(
      'repos/omnirogue/omnirogue/actions/runs?branch=prod-omnirogue&per_page=30'
    )
  })

  it('compares only when the newest deploy head is a later commit', async () => {
    answer((args) => {
      if (args[0] === 'pr') {
        return view()
      }
      return args[1]?.includes('/compare/')
        ? JSON.stringify({ status: 'ahead' })
        : runs(deployRun(LATER, '2026-09-22T13:00:00Z', null))
    })
    const facts = await readSessionPullRequestFacts(REF)
    expect(facts?.deploy.status).toBe('running')
    expect(gh.mock.calls.map((call) => call[0][1])).toContain(
      `repos/omnirogue/omnirogue/compare/${MERGE}...${LATER}`
    )
  })

  it('says waiting when no deploy since the merge carries it, and nothing for undeployed bases', async () => {
    answer((args) => (args[0] === 'pr' ? view() : runs(deployRun(LATER, '2026-09-22T09:00:00Z'))))
    expect((await readSessionPullRequestFacts(REF))?.deploy.status).toBe('waiting')

    resetSessionPullRequestFactsCacheForTest()
    answer((args) => (args[0] === 'pr' ? view({ baseRefName: 'main' }) : runs()))
    expect((await readSessionPullRequestFacts(REF))?.deploy).toEqual({
      workflows: [],
      status: null,
      url: null
    })
  })

  it('keeps a draft with failing checks unmerged and undeployed', async () => {
    answer((args) =>
      args[0] === 'pr'
        ? view({
            state: 'OPEN',
            isDraft: true,
            mergeCommit: null,
            mergedAt: null,
            statusCheckRollup: [
              { status: 'COMPLETED', conclusion: 'FAILURE' },
              { status: 'COMPLETED', conclusion: 'SUCCESS' }
            ]
          })
        : runs(deployRun(LATER, '2026-09-22T09:00:00Z'))
    )
    expect(await readSessionPullRequestFacts(REF)).toMatchObject({
      state: 'draft',
      checks: 'failure',
      failingChecks: 1,
      deploy: { workflows: ['Deploy to Production'], status: null }
    })
  })

  it('shares one read between concurrent asks and caches the answer', async () => {
    answer((args) => (args[0] === 'pr' ? view({ baseRefName: '' }) : runs()))
    await Promise.all([readSessionPullRequestFacts(REF), readSessionPullRequestFacts(REF)])
    await readSessionPullRequestFacts(REF)
    expect(gh).toHaveBeenCalledTimes(1)
  })

  it('answers null when GitHub cannot, and refuses a malformed reference', async () => {
    gh.mockRejectedValue(new Error('HTTP 404'))
    expect(await readSessionPullRequestFacts(REF)).toBeNull()
    await expect(
      readSessionPullRequestFacts({ owner: 'a b', repo: 'x', number: 1 })
    ).rejects.toThrow()
  })
})
