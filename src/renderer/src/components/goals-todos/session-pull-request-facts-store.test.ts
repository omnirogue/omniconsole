// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionPullRequestFacts,
  SessionPullRequestRef
} from '../../../../shared/session-pull-request-facts'
import {
  resetSessionPullRequestFactsForTest,
  SESSION_PULL_REQUEST_REFRESH_MS,
  useKnownPullRequestFacts,
  useSessionPullRequestFacts
} from './session-pull-request-facts-store'

const REF: SessionPullRequestRef = { owner: 'omnirogue', repo: 'omnirogue', number: 1007 }

function facts(state: SessionPullRequestFacts['state']): SessionPullRequestFacts {
  return {
    ...REF,
    title: 'Align catalog options',
    url: 'https://github.com/omnirogue/omnirogue/pull/1007',
    state,
    approved: false,
    checks: 'success',
    failingChecks: 0,
    baseBranch: 'prod-omnirogue',
    mergeCommit: state === 'merged' ? 'abc1234' : null,
    mergedAt: state === 'merged' ? 1 : null,
    settledAt: state === 'merged' ? 1 : null,
    deploy: {
      workflows: ['Deploy to Production'],
      status: state === 'merged' ? 'success' : null,
      url: null
    }
  }
}

const read = vi.fn<(ref: SessionPullRequestRef) => Promise<SessionPullRequestFacts | null>>()

beforeEach(() => {
  vi.useFakeTimers()
  resetSessionPullRequestFactsForTest()
  read.mockReset()
  vi.stubGlobal('api', { sessionFiles: { pullRequestFacts: read } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve()
    }
  })
}

describe('useSessionPullRequestFacts', () => {
  it('reads on open, re-reads each minute while moving, and stops once settled', async () => {
    read.mockResolvedValueOnce(facts('draft')).mockResolvedValue(facts('merged'))
    const { result } = renderHook(() => useSessionPullRequestFacts([REF], 'poll'))
    await flush()
    expect(result.current.map((pr) => pr.state)).toEqual(['draft'])
    await act(async () => {
      vi.advanceTimersByTime(SESSION_PULL_REQUEST_REFRESH_MS)
    })
    await flush()
    expect(result.current.map((pr) => pr.state)).toEqual(['merged'])
    await act(async () => {
      vi.advanceTimersByTime(SESSION_PULL_REQUEST_REFRESH_MS * 3)
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads once, without refreshing, for a header that only needs the latest word', async () => {
    read.mockResolvedValue(facts('draft'))
    renderHook(() => useSessionPullRequestFacts([REF], 'once'))
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(SESSION_PULL_REQUEST_REFRESH_MS * 3)
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while off, and shares what it read', async () => {
    renderHook(() => useSessionPullRequestFacts([REF], 'off'))
    await flush()
    expect(read).not.toHaveBeenCalled()

    read.mockResolvedValue(facts('draft'))
    renderHook(() => useSessionPullRequestFacts([REF], 'poll'))
    await flush()
    const known = renderHook(() => useKnownPullRequestFacts())
    expect(known.result.current.get('omnirogue/omnirogue#1007')?.state).toBe('draft')
  })
})
