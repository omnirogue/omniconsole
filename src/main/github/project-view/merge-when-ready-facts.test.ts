import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runGraphqlMock } = vi.hoisted(() => ({ runGraphqlMock: vi.fn() }))

vi.mock('./internals', () => ({
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  runGraphql: runGraphqlMock,
  validateSlugArgs: (owner: string, repo: string) =>
    owner && repo ? { ok: true } : { ok: false, error: { type: 'validation_error' } }
}))

import { getMergeWhenReadyFactsBySlug } from './merge-when-ready-facts'

const RAW_PR = {
  number: 1747,
  title: 'Fix refunds',
  body: '- [ ] **Merge when ready** (tick)\n\nBody',
  state: 'OPEN',
  isDraft: true,
  url: 'https://github.com/acme/omni/pull/1747',
  createdAt: '2026-10-13T10:00:00Z',
  author: { login: 'contributor' },
  baseRefName: 'prod-omnirogue',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BEHIND',
  labels: { nodes: [{ name: 'do-not-merge' }, null] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'Tests',
                  status: 'COMPLETED',
                  conclusion: 'FAILURE'
                },
                { __typename: 'CheckRun', name: 'Lint', status: 'IN_PROGRESS', conclusion: null },
                {
                  __typename: 'CheckRun',
                  name: 'Cleanup',
                  status: 'COMPLETED',
                  conclusion: 'SKIPPED'
                },
                { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS' }
              ]
            }
          }
        }
      }
    ]
  },
  timelineItems: {
    nodes: [
      {
        __typename: 'LabeledEvent',
        createdAt: '2026-10-13T11:04:28Z',
        actor: { login: 'contributor' },
        label: { name: 'do-not-merge' }
      },
      {
        __typename: 'RenamedTitleEvent',
        createdAt: '2026-10-13T11:05:00Z',
        actor: null,
        previousTitle: 'Fix refund',
        currentTitle: 'Fix refunds'
      }
    ]
  }
}

describe('getMergeWhenReadyFactsBySlug', () => {
  beforeEach(() => {
    runGraphqlMock.mockReset()
  })

  it('reads every PR in one aliased query and maps its facts', async () => {
    runGraphqlMock.mockResolvedValue({
      ok: true,
      data: { repository: { pr0: RAW_PR, pr1: null } }
    })

    const result = await getMergeWhenReadyFactsBySlug({
      owner: 'acme',
      repo: 'omni',
      host: 'github.com',
      numbers: [1747, 9, 1747]
    })

    const [query, vars, exec] = runGraphqlMock.mock.calls[0]
    expect(query).toContain('pr0: pullRequest(number: 1747)')
    expect(query).toContain('pr1: pullRequest(number: 9)')
    expect(query).not.toContain('pr2:')
    expect(vars).toEqual({ owner: 'acme', repo: 'omni' })
    expect(exec).toEqual({ host: 'github.com' })
    expect(result).toEqual({
      ok: true,
      missing: [9],
      pullRequests: [
        {
          number: 1747,
          title: 'Fix refunds',
          body: '- [ ] **Merge when ready** (tick)\n\nBody',
          state: 'open',
          isDraft: true,
          url: 'https://github.com/acme/omni/pull/1747',
          author: 'contributor',
          createdAt: '2026-10-13T10:00:00Z',
          baseRefName: 'prod-omnirogue',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BEHIND',
          labels: ['do-not-merge'],
          checks: [
            { name: 'Tests', state: 'failure' },
            { name: 'Lint', state: 'pending' },
            { name: 'Cleanup', state: 'neutral' },
            { name: 'deploy/preview', state: 'success' }
          ],
          labelEvents: [
            { label: 'do-not-merge', login: 'contributor', at: '2026-10-13T11:04:28Z' }
          ],
          titleEvents: [
            {
              previousTitle: 'Fix refund',
              currentTitle: 'Fix refunds',
              login: null,
              at: '2026-10-13T11:05:00Z'
            }
          ],
          olderEventsOmitted: false
        }
      ]
    })
  })

  it('fails the read when a PR has more labels than one page, so no hold goes unseen', async () => {
    runGraphqlMock.mockResolvedValue({
      ok: true,
      data: {
        repository: {
          pr0: RAW_PR,
          pr1: { ...RAW_PR, number: 8, labels: { pageInfo: { hasNextPage: true }, nodes: [] } }
        }
      }
    })

    const result = await getMergeWhenReadyFactsBySlug({
      owner: 'acme',
      repo: 'omni',
      numbers: [1747, 8]
    })

    expect(result).toMatchObject({ ok: false, error: { type: 'too_large' } })
  })

  it('says when GitHub has older label and title changes than it returned', async () => {
    runGraphqlMock.mockResolvedValue({
      ok: true,
      data: {
        repository: {
          pr0: {
            ...RAW_PR,
            timelineItems: { ...RAW_PR.timelineItems, pageInfo: { hasPreviousPage: true } }
          }
        }
      }
    })

    const result = await getMergeWhenReadyFactsBySlug({
      owner: 'acme',
      repo: 'omni',
      numbers: [1747]
    })

    expect(result.ok && result.pullRequests[0].olderEventsOmitted).toBe(true)
  })

  it('keeps the other PRs when GitHub reports one listed PR as missing', async () => {
    runGraphqlMock.mockResolvedValue({
      ok: false,
      error: { type: 'not_found', message: 'Could not resolve' },
      raw: {
        stderr: '',
        stdout: JSON.stringify({
          data: { repository: { pr0: RAW_PR, pr1: null } },
          errors: [{ type: 'NOT_FOUND', path: ['repository', 'pr1'] }]
        })
      }
    })

    const result = await getMergeWhenReadyFactsBySlug({
      owner: 'acme',
      repo: 'omni',
      numbers: [1747, 999999]
    })

    expect(result).toMatchObject({ ok: true, missing: [999999] })
    expect(result.ok && result.pullRequests.map((pr) => pr.number)).toEqual([1747])
  })

  it('fails the batch for any other GitHub error', async () => {
    runGraphqlMock.mockResolvedValue({
      ok: false,
      error: { type: 'not_found', message: 'Could not resolve to a Repository' },
      raw: {
        stderr: '',
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ type: 'NOT_FOUND', path: ['repository'] }]
        })
      }
    })

    const result = await getMergeWhenReadyFactsBySlug({
      owner: 'acme',
      repo: 'gone',
      numbers: [1]
    })

    expect(result).toEqual({
      ok: false,
      error: { type: 'not_found', message: 'Could not resolve to a Repository' }
    })
  })

  it('rejects empty, oversized and non-integer batches without calling GitHub', async () => {
    for (const numbers of [[], Array.from({ length: 51 }, (_, i) => i + 1), [1.5], [0]]) {
      const result = await getMergeWhenReadyFactsBySlug({ owner: 'acme', repo: 'omni', numbers })
      expect(result).toMatchObject({ ok: false, error: { type: 'validation_error' } })
    }
    expect(runGraphqlMock).not.toHaveBeenCalled()
  })
})
