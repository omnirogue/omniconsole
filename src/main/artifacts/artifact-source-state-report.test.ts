import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'
import {
  createSourceStateReporter,
  publicSourceReason,
  sourceStateResult,
  wakeCopyReport
} from './artifact-source-state-report'

function entry(sleep: Partial<ArtifactReviewSleep>): ReviewSleepEntry {
  return {
    sourceKey: '/w/plan.md',
    slug: 'abcdefghij',
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'conv',
      paneKey: 'p',
      worktreeId: 'w',
      account: 'a',
      revision: 2
    },
    sleep: { state: 'asleep', revision: 2, armedAt: 1, at: 1_000, provider: 'claude', ...sleep }
  }
}

describe('source state report', () => {
  it('beats first, then sends each state once per change with only fixed reasons', async () => {
    const posted: [string, unknown][] = []
    let entries = [entry({ reason: 'capacity: waiting for sal@x.com (resets ~16:40 ET)' })]
    const reporter = createSourceStateReporter({
      entries: () => entries,
      host: async () => ({ hostId: 'host_1', host: 'Sal’s MacBook Pro' }),
      windowAttached: () => true,
      post: vi.fn(async (path, body) => {
        posted.push([path, body])
        return 'ok' as const
      }),
      now: () => 2_000
    })
    await reporter.heartbeat()
    await reporter.states()
    await reporter.states()
    // A heartbeat before the delivery pass and another after the states.
    expect(posted.map(([path]) => path)).toEqual([
      '/source-heartbeat',
      '/abcdefghij/source-state',
      '/source-heartbeat',
      '/source-heartbeat'
    ])
    const states = () => posted.filter(([path]) => path.endsWith('/source-state'))
    expect(states()[0]![1]).toEqual({
      state: 'asleep',
      revision: 2,
      hostId: 'host_1',
      host: 'Sal’s MacBook Pro',
      at: new Date(1_000).toISOString(),
      portable: null,
      reason: 'capacity'
    })
    entries = [entry({ state: 'awake', at: 1_500 })]
    await reporter.states()
    expect(states()).toHaveLength(2)
    expect(states()[1]![1]).not.toHaveProperty('reason')
  })

  it('leaves a server without the endpoints alone for a while', async () => {
    const post = vi.fn(async () => 'unsupported' as const)
    let now = 0
    const reporter = createSourceStateReporter({
      entries: () => [entry({})],
      host: async () => ({ hostId: 'host_1', host: 'Mac' }),
      windowAttached: () => true,
      post,
      now: () => now
    })
    await reporter.heartbeat()
    await reporter.states()
    expect(post).toHaveBeenCalledTimes(1)
    now = 60_000
    await reporter.heartbeat()
    expect(post).toHaveBeenCalledTimes(1)
    now = 31 * 60_000
    await reporter.heartbeat()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('tells an old server from a refusal', () => {
    expect(sourceStateResult(new OrcaCloudRequestError(405))).toBe('unsupported')
    expect(sourceStateResult(new OrcaCloudRequestError(404))).toBe('unsupported')
    expect(sourceStateResult(new OrcaCloudRequestError(404, 'artifact_not_found'))).toBe('refused')
    expect(sourceStateResult(new OrcaCloudRequestError(409, 'revision_ahead'))).toBe('refused')
    expect(sourceStateResult(new OrcaCloudRequestError(400, 'invalid_at'))).toBe('failed')
    expect(sourceStateResult(new OrcaCloudRequestError(429, 'rate_limited'))).toBe('failed')
    expect(sourceStateResult(new OrcaCloudRequestError(502))).toBe('failed')
    expect(sourceStateResult(new Error('offline'))).toBe('failed')
  })

  it('never resends a refused state, and only a computer with a window and waits beats', async () => {
    const post = vi.fn(async (path: string) =>
      path.endsWith('/source-state') ? ('refused' as const) : ('ok' as const)
    )
    let window = false
    let entries = [entry({})]
    const reporter = createSourceStateReporter({
      entries: () => entries,
      host: async () => ({ hostId: 'host_1', host: 'Mac' }),
      windowAttached: () => window,
      post,
      now: () => 2_000
    })
    await reporter.heartbeat()
    await reporter.states()
    await reporter.states()
    expect(post.mock.calls.map(([path]) => path)).toEqual(['/abcdefghij/source-state'])
    window = true
    entries = [entry({ state: 'awake' })]
    await reporter.heartbeat()
    expect(post).toHaveBeenCalledTimes(1)
    // A decision a week late still wakes it here, so an old open wait still beats.
    entries = [entry({ at: 2_000 - 8 * 24 * 60 * 60_000 })]
    await reporter.heartbeat()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('reports two share records of one page once each', async () => {
    const post = vi.fn(async () => 'ok' as const)
    const reporter = createSourceStateReporter({
      entries: () => [entry({}), { ...entry({ state: 'stalled' }), sourceKey: '/w/copy.md' }],
      host: async () => ({ hostId: 'host_1', host: 'Mac' }),
      windowAttached: () => false,
      post,
      now: () => 2_000
    })
    await reporter.states()
    await reporter.states()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('never sends an account, path or error text as the reason', () => {
    const reason = (state: ArtifactReviewSleep['state'], text?: string) =>
      publicSourceReason({ ...entry({}).sleep, state, ...(text ? { reason: text } : {}) })
    expect(reason('asleep', 'capacity: a@b.c is signed out on this computer (not signed in)')).toBe(
      'account signed out'
    )
    expect(reason('stalled', 'spawn ENOENT /Users/me/x')).toBe('could not start')
    expect(reason('stalled', 'Rejected; kept because it is protected (pinned)')).toBe(
      'kept: protected'
    )
    expect(reason('stalled', 'Rejected; kept because it still waits on page x')).toBe(
      'kept: another page open'
    )
    expect(reason('asleep', 'Rejected · deleted when the OmniConsole window opens')).toBe(
      'window closed'
    )
    expect(
      reason('stalled', 'Rejected; its tab “Plan” did not close, so nothing was deleted')
    ).toBe('kept: protected')
    expect(reason('stalled', 'Rejected · told to stop; deleted when it is idle')).toBeUndefined()
    expect(reason('deleted', 'Removed protected-files worktree')).toBeUndefined()
    expect(reason('stalled', "EACCES: open '/Volumes/protected/x'")).toBe('could not start')
    expect(
      reason('deleted', 'Rejected on review page x: deleted /Users/me/.claude/...')
    ).toBeUndefined()
  })

  it('says whether another computer can wake it, and why not', () => {
    const asleep = entry({}).sleep
    expect(wakeCopyReport(asleep)).toEqual({ portable: null })
    expect(
      wakeCopyReport({ ...asleep, wakeCopy: { revision: 2, at: 1, sha256: 'a'.repeat(64) } })
    ).toEqual({
      portable: true
    })
    expect(
      wakeCopyReport({ ...asleep, wakeCopy: { revision: 2, at: 1, refused: 'unpushed changes' } })
    ).toEqual({ portable: false, reason: 'unpushed changes' })
    expect(
      wakeCopyReport({ ...asleep, wakeCopy: { revision: 1, at: 1, sha256: 'a'.repeat(64) } })
    ).toEqual({ portable: null })
  })
})
