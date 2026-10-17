import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { reviewWaitChip } from '../../shared/artifact-review-waits'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'
import { mergeReviewWaits } from './artifact-review-waits'
import { reconcileReviewAttention, type ArtifactReviewAttention } from './artifact-review-attention'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'

function local(slug: string, state: ArtifactReviewSleep['state']): ReviewSleepEntry {
  return {
    sourceKey: `/w/${slug}.md`,
    slug,
    shareUrl: `https://omnios.example/a/${slug}`,
    title: `${slug}.md`,
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'conv',
      paneKey: 'tab:leaf',
      worktreeId: 'w',
      account: 'a',
      revision: 1
    },
    sleep: { state, revision: 1, armedAt: 1, at: 2, provider: 'claude' }
  }
}

describe('review waits for the Work tab', () => {
  it('joins the inbox with this computer’s own waits, local state first', () => {
    const items = mergeReviewWaits(
      [
        {
          slug: 'mine',
          title: 'Plan',
          question: 'Build it?',
          summary: 'Phase 1 lists answered pages under History.',
          shareUrl: 'https://omnios.example/a/mine',
          status: 'pending',
          sourceState: { state: 'waiting', host: 'Old report' }
        },
        {
          slug: 'theirs',
          title: 'Their plan',
          summary: '  ',
          status: 'pending',
          sourceState: { state: 'asleep', host: 'Uma’s Mac', hostOnline: false }
        }
      ],
      [local('mine', 'asleep'), local('only-here', 'stalled'), local('done-here', 'awake')],
      'Sal’s MacBook Pro'
    )
    expect(items.map((item) => [item.slug, item.session?.state, item.session?.host])).toEqual([
      ['mine', 'asleep', 'Sal’s MacBook Pro'],
      ['theirs', 'asleep', 'Uma’s Mac'],
      ['only-here', 'stalled', 'Sal’s MacBook Pro']
    ])
    expect(items[0]!.session).toMatchObject({ local: true, paneKey: 'tab:leaf' })
    expect(items[1]!.session).toMatchObject({ local: false, hostOnline: false })
    expect(items[2]).toMatchObject({
      title: 'only-here.md',
      shareUrl: 'https://omnios.example/a/only-here'
    })
    // OmniOS's short version of each page; a blank one, or a page only this computer knows, has none.
    expect(items.map((item) => item.summary)).toEqual([
      'Phase 1 lists answered pages under History.',
      null,
      null
    ])
  })

  it('words each state as OmniOS does', () => {
    const chip = (state: string, status = 'pending', reason?: string) =>
      reviewWaitChip({
        status,
        session: { state, host: 'MacBook', at: null, local: true, ...(reason ? { reason } : {}) }
      })
    expect(chip('waiting')).toBe('Waiting on MacBook')
    expect(chip('asleep')).toBe('Asleep on MacBook')
    expect(chip('asleep', 'approved', 'capacity')).toBe('Approved · waiting for account capacity')
    expect(chip('deleted', 'rejected')).toBe('Rejected · deleted')
    expect(chip('stalled', 'approved', 'could not start')).toBe('Stalled: could not start')
    expect(chip('migrating')).toBe('migrating')
    expect(reviewWaitChip({ status: 'pending', session: null })).toBeNull()
  })

  it('uses this computer’s state only for the revision now waiting, once per page', () => {
    const older = local('mine', 'awake')
    const items = mergeReviewWaits(
      [
        {
          slug: 'mine',
          title: 'Plan',
          status: 'pending',
          revision: 2,
          sourceState: { state: 'waiting', host: 'Mac Studio' }
        }
      ],
      [older, local('twice', 'asleep'), { ...local('twice', 'stalled'), sourceKey: '/w/copy.md' }],
      'Sal’s MacBook Pro'
    )
    expect(items.map((item) => [item.slug, item.session?.state, item.session?.local])).toEqual([
      ['mine', 'waiting', false],
      ['twice', 'asleep', true]
    ])
    // OmniOS's own report about an earlier revision is ignored too; the latest revision wins locally.
    const newer = { ...local('pick', 'waiting'), sourceKey: '/w/new.md' }
    newer.sleep = { ...newer.sleep, revision: 2, at: 1 }
    const [stale, picked] = mergeReviewWaits(
      [
        {
          slug: 'old',
          status: 'pending',
          revision: 2,
          sourceState: { state: 'awake', revision: 1 }
        }
      ],
      [{ ...local('pick', 'asleep'), sleep: { ...local('pick', 'asleep').sleep, at: 99 } }, newer],
      'MacBook'
    )
    expect(stale!.session).toBeNull()
    expect(picked!.session?.state).toBe('waiting')
  })

  it('shows only OmniOS’s fixed words for a local reason, keeping the full one as detail', () => {
    const stalled = local('mine', 'stalled')
    stalled.sleep.reason = 'Error: spawn /Users/maintainer/.claude-accounts/x ENOENT'
    const [item] = mergeReviewWaits([], [stalled], 'MacBook')
    expect(item!.session).toMatchObject({ reason: 'could not start', detail: stalled.sleep.reason })
  })

  it.each(['waiting', 'asleep', 'waking', 'stalled'] as const)(
    'does not resurrect resolved attention while continuation is %s',
    (state) => {
      const resolved = {
        ...local('mine', state),
        reviewAttention: {
          revision: 1,
          status: 'approved',
          needsYou: false,
          observedAt: 5
        }
      }
      expect(mergeReviewWaits([], [resolved], 'Mac')).toEqual([])
      expect(
        mergeReviewWaits(
          [{ slug: 'mine', status: 'pending', revision: 1 }],
          [resolved],
          'Mac',
          new Map([['mine', resolved.reviewAttention]])
        )
      ).toEqual([])
      // A stale copy of the publishing record cannot restore attention either.
      expect(
        mergeReviewWaits(
          [],
          [
            resolved,
            { ...local('mine', state), sourceKey: '/copy', sleep: { ...resolved.sleep, at: 9 } }
          ],
          'Mac'
        )
      ).toEqual([])
    }
  )

  it.each(['read-failed', 'save-failed', 'saved'] as const)(
    'honors a restored positive inbox over cached dismissal unless later detail is saved: %s',
    async (outcome) => {
      const dismissed = {
        ...local('mine', 'stalled'),
        reviewAttention: { revision: 1, needsYou: false, status: 'pending', observedAt: 5 }
      }
      const stillRetired: ArtifactReviewStatus = {
        artifact: { slug: 'mine', revision: 1 } as ArtifactReviewStatus['artifact'],
        shareUrl: '',
        status: 'pending',
        needsYou: false,
        latest: null,
        decisions: [],
        viewer: { signedIn: true, isOwner: true, canDecide: true, retired: true }
      }
      const fresh = new Map<string, ArtifactReviewAttention>()
      const save = vi.fn(() => outcome !== 'save-failed')
      const entries = await reconcileReviewAttention([dismissed], {
        read: async () => {
          if (outcome === 'read-failed') {
            throw new Error('offline')
          }
          return { status: 'ok', value: stillRetired }
        },
        save,
        current: () => true,
        now: () => 10,
        observed: (slug, attention) => fresh.set(slug, attention)
      })
      const items = mergeReviewWaits(
        [{ slug: 'mine', status: 'pending', revision: 1 }],
        entries,
        'Mac',
        fresh
      )
      expect(items).toHaveLength(outcome === 'saved' ? 0 : 1)
      expect(fresh.size).toBe(outcome === 'saved' ? 1 : 0)
      if (outcome === 'read-failed') {
        expect(save).not.toHaveBeenCalled()
      }
    }
  )

  it('does not treat absence from a limited or unavailable inbox as resolution', () => {
    expect(mergeReviewWaits([], [local('mine', 'waiting')], 'Mac')).toHaveLength(1)
    expect(
      mergeReviewWaits([{ slug: 'mine', status: 'approved' }], [local('mine', 'waiting')], 'Mac')
    ).toEqual([])
  })

  it('preserves attention when a future server returns an unknown review status', () => {
    expect(
      mergeReviewWaits(
        [{ slug: 'mine', status: 'future-pending-state' }],
        [local('mine', 'waiting')],
        'Mac'
      )
    ).toHaveLength(1)
  })

  it('never attaches a different revision’s local session to an inbox question', () => {
    const newer = local('mine', 'waiting')
    newer.sleep.revision = 2
    expect(mergeReviewWaits([{ slug: 'mine', revision: 1 }], [newer], 'Mac')[0]?.session).toBeNull()
    newer.reviewAttention = { revision: 2, needsYou: true, status: 'pending', observedAt: 5 }
    const items = mergeReviewWaits([{ slug: 'mine', revision: 1 }], [newer], 'Mac')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ revision: 2, session: { local: true } })
  })

  it('retains new-revision attention after an old revision was resolved', () => {
    const old = {
      ...local('mine', 'asleep'),
      reviewAttention: {
        revision: 1,
        needsYou: false,
        status: 'approved',
        observedAt: 5
      }
    }
    expect(
      mergeReviewWaits([{ slug: 'mine', revision: 2, status: 'pending' }], [old], 'Mac')
    ).toMatchObject([{ slug: 'mine', revision: 2, session: null }])
  })
})
