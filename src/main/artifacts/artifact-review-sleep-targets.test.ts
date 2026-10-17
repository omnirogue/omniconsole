import { describe, expect, it } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import {
  countAdvanceableReviewWaits,
  listReviewSleepTargets,
  type ReviewSleepEntry
} from './artifact-review-sleep-targets'

function entry(
  slug: string,
  paneKey: string,
  state: ArtifactReviewSleep['state']
): ReviewSleepEntry {
  return {
    sourceKey: `/w/${slug}.md`,
    slug,
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'conv',
      paneKey,
      worktreeId: 'w',
      account: 'a',
      revision: 1
    },
    sleep: { state, revision: 1, armedAt: 1, at: 1, provider: 'claude', model: 'opus' }
  }
}

describe('review sleep targets', () => {
  it('lists each waiting pane once with the review wait and its model', () => {
    expect(
      listReviewSleepTargets({ reviewWaitLiveMinutes: 720 }, [
        entry('a', 'p1', 'waiting'),
        entry('b', 'p1', 'waiting'),
        entry('c', 'p2', 'asleep')
      ])
    ).toEqual([
      { worktreeId: 'w', paneKey: 'p1', idleMs: 720 * 60_000, launchOptions: { model: 'opus' } }
    ])
  })

  it('skips a pane a decision is waking right now', () => {
    expect(
      listReviewSleepTargets({}, [entry('a', 'p1', 'waiting'), entry('b', 'p1', 'waking')])
    ).toEqual([])
  })

  it('keeps a quit app running only for live waits from the last week', () => {
    const day = 24 * 60 * 60_000
    const at = (state: ArtifactReviewSleep['state'], ageDays: number): ReviewSleepEntry => {
      const waiting = entry(`${state}${ageDays}`, `p${ageDays}`, state)
      return { ...waiting, sleep: { ...waiting.sleep, at: 30 * day - ageDays * day } }
    }
    expect(
      countAdvanceableReviewWaits(
        [at('waiting', 1), at('waiting', 8), at('asleep', 1), at('stalled', 1), at('waking', 0)],
        30 * day
      )
    ).toBe(1)
  })
})
