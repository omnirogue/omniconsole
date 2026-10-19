import { describe, expect, it, vi } from 'vitest'
import type {
  ArtifactReviewDecision,
  ArtifactReviewProgress,
  ArtifactReviewStatus
} from '../../shared/artifact-review'
import { sentRow } from '../../shared/backoffice-work-rows'
import type { WorkQueueThread } from '../../shared/backoffice-work-views'
import type { HandoffDetail } from '../../shared/console-handoff-contract'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import {
  deliverSourceArtifactReviews,
  type SourceReviewEntry,
  type SourceReviewWatchDeps
} from './artifact-source-review-watch'
import {
  HandoffArtifactReviewWatch,
  type HandoffArtifactReviewWatchDeps,
  type WatchedArtifactReview
} from './handoff-artifact-review-watch'

const REVIEW = { slug: 'launch-plan', title: 'Launch plan' }
const OPENED = '2026-09-23T10:00:00Z'

function nativeReviewHarness() {
  let saved: SourceReviewEntry = {
    sourceKey: '/work/review.md',
    slug: 'launch-plan',
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'exact-provider-conversation',
      paneKey: 'pane',
      worktreeId: 'folder',
      account: 'account',
      revision: 1
    }
  }
  const queue = new Map<string, PromptQueueEntry>()
  const status = {
    ...page(decision('dec_1', 'approved')),
    artifact: { slug: 'launch-plan', revision: 1 }
  } as ArtifactReviewStatus
  const deps: SourceReviewWatchDeps = {
    entries: () => [structuredClone(saved)],
    current: vi.fn(() => true),
    status: vi.fn(async () => status),
    source: vi.fn(async () => ({ paneKey: 'pane', worktreeId: 'folder', kind: 'pty' as const })),
    queued: (_source, id) => queue.get(id),
    save: (entry, receipt) => {
      if (JSON.stringify(saved) !== JSON.stringify(entry)) {
        return false
      }
      saved = { ...entry, sourceReview: { ...entry.sourceReview, receipt } }
      return true
    },
    enqueue: vi.fn(async (_entry, _source, id, text, retryId) => {
      expect(saved.sourceReview.receipt?.entryId).toBe(id)
      if (retryId) {
        queue.delete(retryId)
      }
      if (!queue.has(id)) {
        queue.set(id, { id, text, createdAt: 1, state: 'queued' })
      }
      return true
    })
  }
  return { deps, queue, status, saved: () => saved }
}

function thread(state: 'open' | 'replied' | 'resolved'): HandoffDetail['thread'] {
  return {
    id: 'hth_page',
    board_task_id: null,
    author_employee_id: 'emp_sender',
    recipient_employee_id: 'emp_reader',
    title: 'Review: Launch plan',
    state,
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: OPENED
  }
}

function detail(state: 'open' | 'replied' | 'resolved' = 'open'): HandoffDetail {
  return {
    thread: thread(state),
    files: [],
    reviews: [],
    entries: [
      {
        id: 'hent_1',
        kind: 'handoff',
        author_employee_id: 'emp_sender',
        body: 'Please review',
        created: OPENED,
        references: [{ kind: 'artifact-review', ref: REVIEW.slug, label: REVIEW.title }]
      }
    ]
  } as unknown as HandoffDetail
}

function decision(
  id: string,
  kind: ArtifactReviewDecision['decision'],
  at = '2026-09-23T12:00:00Z'
): ArtifactReviewDecision {
  return {
    id,
    revision: 1,
    decision: kind,
    comment: kind === 'approved' ? '' : 'Fix the date',
    edits: null,
    by: { email: 'reader@example.com', name: 'Reader' },
    at
  }
}

function page(latest: ArtifactReviewDecision | null): ArtifactReviewStatus {
  return {
    shareUrl: 'https://app.omnisi.ai/a/launch-plan',
    status: latest?.decision ?? 'pending',
    latest,
    decisions: latest ? [latest] : [],
    viewer: { signedIn: true, isOwner: true, canDecide: false }
  } as unknown as ArtifactReviewStatus
}

function harness(latest: ArtifactReviewDecision | null, principal = 'emp_sender') {
  let saved: WatchedArtifactReview[] = []
  const deps = {
    store: { load: () => saved.map((entry) => ({ ...entry })), save: (next) => (saved = next) },
    principal: async () => principal,
    getThread: vi.fn<HandoffArtifactReviewWatchDeps['getThread']>(async () => ({
      ok: true,
      data: detail()
    })),
    respond: vi.fn<HandoffArtifactReviewWatchDeps['respond']>(async () => ({
      ok: true,
      data: { thread_id: 'hth_page', entry_id: 'hent_2' }
    })),
    reviewStatus: vi.fn<HandoffArtifactReviewWatchDeps['reviewStatus']>(async () => ({
      status: 'ok',
      value: page(latest)
    })),
    now: () => Date.parse(OPENED)
  } satisfies HandoffArtifactReviewWatchDeps
  const watch = new HandoffArtifactReviewWatch(deps)
  watch.track({
    threadId: 'hth_page',
    review: REVIEW,
    recipient: 'emp_reader',
    sender: 'emp_sender'
  })
  return { watch, deps }
}

/** The sender's Sent row once the hub applied the posted entry's state. */
function senderRow(state: 'open' | 'replied' | 'resolved') {
  return sentRow({ ...thread(state), files: [], reviews: [] } as WorkQueueThread)
}

describe('a page decision comes back into the handoff thread', () => {
  it('persists native acceptance without typing and does not repeat it after restart', async () => {
    const h = nativeReviewHarness()
    h.deps.native = vi.fn<NonNullable<SourceReviewWatchDeps['native']>>(
      async (_entry, _source, _text, prepare) => {
        expect(prepare('019a2152-ea25-72c4-b13c-826e98410ed4')).toBe(true)
        expect(h.saved().sourceReview.receipt?.status).toBe('sending')
        return { status: 'queued', nativeItemId: 'native-item' }
      }
    )
    await deliverSourceArtifactReviews(h.deps)
    expect(h.saved().sourceReview.receipt).toMatchObject({
      status: 'queued',
      transport: 'codex-queue',
      nativeItemId: 'native-item',
      nativeNonce: '019a2152-ea25-72c4-b13c-826e98410ed4'
    })
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.native).toHaveBeenCalledOnce()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it.each(['crash', 'uncertain'] as const)(
    'never repeats a native %s or falls back to typing',
    async (outcome) => {
      const h = nativeReviewHarness()
      h.deps.native = vi.fn<NonNullable<SourceReviewWatchDeps['native']>>(
        async (_entry, _source, _text, prepare) => {
          expect(prepare('019a2152-ea25-72c4-b13c-826e98410ed4')).toBe(true)
          if (outcome === 'crash') {
            throw new Error('process terminated after native spawn')
          }
          return { status: 'uncertain', reason: 'queue-unconfirmed' }
        }
      )
      await deliverSourceArtifactReviews(h.deps)
      await deliverSourceArtifactReviews(h.deps)
      expect(h.deps.native).toHaveBeenCalledOnce()
      expect(h.deps.enqueue).not.toHaveBeenCalled()
      expect(h.saved().sourceReview.receipt?.status).toBe(
        outcome === 'crash' ? 'sending' : 'uncertain'
      )
    }
  )

  it('retries an unstarted native attempt but keeps an existing PTY queue on its original door', async () => {
    const h = nativeReviewHarness()
    h.deps.native = vi.fn<NonNullable<SourceReviewWatchDeps['native']>>(async () => ({
      status: 'not-started',
      reason: 'native-writer-unverifiable'
    }))
    await deliverSourceArtifactReviews(h.deps)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.native).toHaveBeenCalledTimes(2)
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    expect(h.saved().sourceReview.receipt?.status).toBe('prepared')
    delete h.deps.native
    await deliverSourceArtifactReviews(h.deps)
    h.deps.native = vi.fn(async () => {
      throw new Error('must not switch an existing PTY attempt')
    })
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.native).not.toHaveBeenCalled()
    expect(h.queue.size).toBe(1)
  })

  it('queues native decisions once and restores their binding while still queued', async () => {
    const h = nativeReviewHarness()
    await deliverSourceArtifactReviews(h.deps)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.queue.size).toBe(1)
    expect(h.deps.enqueue).toHaveBeenCalledTimes(2)
    expect(h.saved().sourceReview.receipt?.status).toBe('queued')
    const entry = [...h.queue.values()][0]!
    expect(entry.text).toContain('omni artifacts status launch-plan --json')
    entry.state = 'delivered'
    await deliverSourceArtifactReviews(h.deps)
    h.queue.clear()
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).toHaveBeenCalledTimes(2)
  })

  it('preserves a prepared native notice across a host outage without changing its id', async () => {
    const h = nativeReviewHarness()
    vi.mocked(h.deps.enqueue).mockResolvedValueOnce(false)
    await deliverSourceArtifactReviews(h.deps)
    const prepared = h.saved().sourceReview.receipt!
    expect(prepared.status).toBe('prepared')
    await deliverSourceArtifactReviews(h.deps)
    expect(h.saved().sourceReview.receipt).toEqual({ ...prepared, status: 'queued' })
  })

  it('does not deliver a stale revision, another owner, or after the source account changed', async () => {
    const h = nativeReviewHarness()
    h.status.artifact.revision = 2
    await deliverSourceArtifactReviews(h.deps)
    h.status.artifact.revision = 1
    h.status.viewer.isOwner = false
    await deliverSourceArtifactReviews(h.deps)
    h.status.viewer.isOwner = true
    vi.mocked(h.deps.status).mockImplementation(async () => {
      vi.mocked(h.deps.current).mockReturnValue(false)
      return h.status
    })
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it('retries only a proven unsent native notice and preserves uncertainty otherwise', async () => {
    const h = nativeReviewHarness()
    await deliverSourceArtifactReviews(h.deps)
    const first = [...h.queue.values()][0]!
    first.state = 'failed'
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).toHaveBeenCalledTimes(1)
    first.unsent = true
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).toHaveBeenCalledTimes(2)
    expect(h.saved().sourceReview.receipt?.attempt).toBe(1)
    expect(h.saved().sourceReview.receipt?.entryId).not.toBe(first.id)
    expect(vi.mocked(h.deps.enqueue).mock.calls[1]?.[4]).toBe(first.id)
  })

  it('holds a decision for a sleeping session until its wake is ready, then delivers once', async () => {
    const h = nativeReviewHarness()
    const delivered = vi.fn()
    h.deps.delivered = delivered
    h.deps.prepare = vi.fn(async () => null)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    h.deps.prepare = vi.fn(async (entry) => ({ entry, woke: true }))
    await deliverSourceArtifactReviews(h.deps)
    const queued = [...h.queue.values()][0]!
    expect(queued.text).toContain('[OmniOS decision] Approved: revision 1')
    expect(queued.text).toContain('this message woke the same conversation')
    expect(delivered).toHaveBeenCalledOnce()
  })

  it('delivers to the pane the woken conversation now runs in', async () => {
    const h = nativeReviewHarness()
    const moved = {
      ...h.saved(),
      sourceReview: {
        ...h.saved().sourceReview,
        paneKey: 'pane-2',
        ledgerId: 'als_aaaaaaaaaaaaaaaaaaaaaaaa'
      }
    }
    h.deps.prepare = vi.fn(async () => ({ entry: moved, woke: true }))
    h.deps.save = (entry, receipt) => {
      expect(entry.sourceReview.paneKey).toBe('pane-2')
      moved.sourceReview = { ...entry.sourceReview, receipt }
      return true
    }
    await deliverSourceArtifactReviews(h.deps)
    expect(vi.mocked(h.deps.source).mock.calls[0]?.[0].sourceReview.paneKey).toBe('pane-2')
    expect(h.deps.enqueue).toHaveBeenCalledOnce()
  })

  it('leaves a decision to the delivery claimer, and marks the wait delivered once it arrived', async () => {
    const h = nativeReviewHarness()
    h.status.latest = { ...h.status.latest!, deliveryKey: 'review:launch-plan:ddec_1' }
    h.deps.delivered = vi.fn()
    h.deps.prepare = vi.fn(async (entry) => ({ entry, woke: true }))
    h.deps.leftToClaimer = vi.fn(() => true)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.prepare).not.toHaveBeenCalled()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    expect(h.deps.delivered).not.toHaveBeenCalled()
    h.status.delivery = { key: 'review:launch-plan:ddec_1', state: 'working' }
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.delivered).toHaveBeenCalledOnce()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it('still handles a Reject itself while the claimer takes approvals', async () => {
    const h = nativeReviewHarness()
    h.status.latest = { ...decision('dec_9', 'rejected'), deliveryKey: 'review:launch-plan:d9' }
    h.status.status = 'rejected'
    h.deps.leftToClaimer = vi.fn(() => true)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.leftToClaimer).not.toHaveBeenCalled()
    expect([...h.queue.values()][0]!.text).toContain('Do now: stop.')
  })

  it('never wakes anyone for a reject; a live session is told to stop', async () => {
    const h = nativeReviewHarness()
    h.status.latest = decision('dec_9', 'rejected')
    h.status.status = 'rejected'
    h.deps.prepare = vi.fn(async (entry) => ({ entry, woke: true }))
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.prepare).not.toHaveBeenCalled()
    expect([...h.queue.values()][0]!.text).toContain('Do now: stop.')
  })

  it('lets a Reject delete the session and sends nothing, or tells a working one to stop', async () => {
    const h = nativeReviewHarness()
    h.status.latest = decision('dec_9', 'rejected')
    h.status.status = 'rejected'
    h.deps.reject = vi.fn(async () => 'done' as const)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.reject).toHaveBeenCalledOnce()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    h.deps.reject = vi.fn(async () => 'deliver' as const)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).toHaveBeenCalledOnce()
  })

  it('ends the wait of a page closed without a decision instead of delivering', async () => {
    const h = nativeReviewHarness()
    h.status.latest = null
    h.status.status = 'pending'
    ;(h.status.artifact as { lifecycle?: string }).lifecycle = 'no_action'
    h.deps.closedWithoutDecision = vi.fn(async () => {})
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.closedWithoutDecision).toHaveBeenCalledOnce()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it('runs native source delivery on the existing timer even with no handoff threads', async () => {
    const { deps } = harness(null)
    const sourceReviews = vi.fn(async () => {})
    const watch = new HandoffArtifactReviewWatch({
      ...deps,
      store: { load: () => [], save: vi.fn() },
      sourceReviews
    })
    await watch.tick()
    expect(sourceReviews).toHaveBeenCalledOnce()
  })

  it('posts an approval as done, once, and stops watching the resolved thread', async () => {
    const { watch, deps } = harness(decision('dec_1', 'approved'))
    expect(senderRow('open').waitingFor).toBe(true)
    await watch.tick()
    expect(deps.respond).toHaveBeenCalledTimes(1)
    expect(deps.respond).toHaveBeenCalledWith({
      threadId: 'hth_page',
      kind: 'done',
      note: 'Reader approved.',
      operationId: 'artrev_hth_page_dec_1'
    })
    expect(watch.watching()).toEqual([])
    // A `done` entry resolves the thread on the hub: nothing is left waiting for the sender.
    expect(senderRow('resolved')).toMatchObject({ waitingFor: false, needsYou: false })
  })

  it('posts changes as a reply, which hands the move back to the sender', async () => {
    const { watch, deps } = harness(decision('dec_2', 'changes_requested'))
    await watch.tick()
    expect(deps.respond).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reply', note: 'Reader requested changes: Fix the date' })
    )
    expect(watch.watching()[0]?.posted).toEqual(['dec_2'])
    // A `reply` entry leaves the thread `replied`: Waiting for clears and it is the sender's turn.
    expect(senderRow('replied')).toMatchObject({ waitingFor: false, needsYou: true })
    await watch.tick()
    expect(deps.respond).toHaveBeenCalledTimes(1)
  })

  it('ignores a decision made before the request was opened', async () => {
    const { watch, deps } = harness(decision('dec_old', 'approved', '2026-09-22T09:00:00Z'))
    await watch.tick()
    expect(deps.respond).not.toHaveBeenCalled()
    expect(watch.watching()).toHaveLength(1)
  })

  it('posts nothing while somebody other than the sender is signed in', async () => {
    const { watch, deps } = harness(decision('dec_1', 'approved'), 'emp_someone_else')
    await watch.tick()
    expect(deps.getThread).not.toHaveBeenCalled()
    expect(deps.respond).not.toHaveBeenCalled()
  })

  it('keeps watching when the post fails, and posts on the next pass', async () => {
    const { watch, deps } = harness(decision('dec_1', 'approved'))
    deps.respond.mockResolvedValueOnce({
      ok: false,
      error: { code: 'network', message: 'offline' }
    } as never)
    await watch.tick()
    expect(watch.watching()).toHaveLength(1)
    await watch.tick()
    expect(deps.respond).toHaveBeenCalledTimes(2)
    expect(watch.watching()).toEqual([])
  })

  it('stops watching a thread that was resolved some other way', async () => {
    const { watch, deps } = harness(decision('dec_1', 'approved'))
    deps.getThread.mockResolvedValueOnce({ ok: true, data: detail('resolved') })
    await watch.tick()
    expect(deps.respond).not.toHaveBeenCalled()
    expect(watch.watching()).toEqual([])
  })
})

type ReviewHarness = ReturnType<typeof nativeReviewHarness>

/** A review on revision 1 whose answers are in, as the server sends it: pending, undecided. */
function responsesIn(progress: Partial<ArtifactReviewProgress> = {}): ReviewHarness {
  const h = nativeReviewHarness()
  h.status.latest = null
  h.status.status = 'pending'
  h.status.decisions = []
  h.status.artifact.title = REVIEW.title
  h.status.artifact.review = {
    question: 'What do you think?',
    reviewers: [],
    status: 'pending',
    statusAt: null,
    type: 'review',
    mode: 'collect'
  }
  h.status.progress = {
    id: 'launch-plan:1',
    revision: 1,
    submitted: 2,
    of: 3,
    setAside: 1,
    everyone: false,
    ready: true,
    readyAt: '2026-10-10T12:00:00Z',
    reason: 'all',
    overdue: false,
    people: [],
    ...progress
  }
  return h
}

describe('a review or study tells the session that asked once its responses are in', () => {
  it('wakes it and tells it once per revision, never as an approval', async () => {
    const h = responsesIn()
    const delivered = vi.fn()
    h.deps.delivered = delivered
    h.deps.prepare = vi.fn(async () => null)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    h.deps.prepare = vi.fn(async (entry) => ({ entry, woke: true }))
    await deliverSourceArtifactReviews(h.deps)
    expect(vi.mocked(h.deps.prepare).mock.calls[0]?.[1]).toBeNull()
    expect(h.saved().sourceReview.receipt).toMatchObject({
      decisionId: 'ready:launch-plan:1',
      status: 'queued'
    })
    const queued = [...h.queue.values()][0]!
    expect(queued.text).toContain(
      '[OmniOS responses] Responses in: 2 of 3 answered, 1 set aside on revision 1 of "Launch plan"'
    )
    expect(queued.text).toContain('This is not an approval')
    expect(queued.text).toContain('omni artifacts status launch-plan --json')
    expect(queued.text).toContain('omni artifacts close launch-plan --done --revision 1')
    expect(queued.text).toContain('this message woke the same conversation')
    expect(queued.text).not.toContain('Approved')
    expect(delivered).toHaveBeenCalledOnce()
    queued.state = 'delivered'
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.enqueue).toHaveBeenCalledOnce()
    // A new revision is asked again, so its responses are told once more.
    h.saved().sourceReview.revision = 2
    h.status.artifact.revision = 2
    h.status.progress = { ...h.status.progress!, id: 'launch-plan:2', revision: 2 }
    await deliverSourceArtifactReviews(h.deps)
    expect(h.saved().sourceReview.receipt?.decisionId).toBe('ready:launch-plan:2')
    expect(h.queue.size).toBe(2)
  })

  it('says the due time passed for an ask anyone may answer', async () => {
    const h = responsesIn({ of: null, setAside: 0, everyone: true, reason: 'due', submitted: 4 })
    await deliverSourceArtifactReviews(h.deps)
    expect([...h.queue.values()][0]!.text).toContain(
      'Responses in: the due time passed (4 answered) on revision 1'
    )
  })

  it('keeps a study summary off its open page, and asks for none when nobody answered', async () => {
    const h = responsesIn()
    h.status.artifact.review = { ...h.status.artifact.review!, type: 'study' }
    await deliverSourceArtifactReviews(h.deps)
    const study = [...h.queue.values()][0]!.text
    expect(study).toContain('in your reply to the owner. Never comment on the page')
    expect(study).not.toContain('artifact_comment')
    const none = responsesIn({ submitted: 0, setAside: 0, reason: 'due' })
    await deliverSourceArtifactReviews(none.deps)
    const told = [...none.queue.values()][0]!.text
    expect(told).toContain('No responses: the due time passed (0 of 3 answered) on revision 1')
    expect(told).toContain('Do now: tell the owner')
    expect(told).not.toMatch(/sum up their|omni artifacts close/)
  })

  it.each<[string, (h: ReviewHarness) => void]>([
    [
      'someone other than the owner reads it',
      (h) => {
        h.status.viewer.isOwner = false
      }
    ],
    [
      'the page is closed',
      (h) => {
        h.status.artifact.lifecycle = 'done'
      }
    ],
    [
      'the page is superseded',
      (h) => {
        h.status.artifact.supersededBy = 'launch-plan-2'
      }
    ],
    [
      'the review was withdrawn',
      (h) => {
        h.status.status = 'withdrawn'
      }
    ],
    [
      'a decision is on the revision',
      (h) => {
        h.status.latest = decision('dec_1', 'approved')
      }
    ],
    [
      'an older server sends no progress',
      (h) => {
        delete h.status.progress
      }
    ],
    [
      'a decision page has no progress',
      (h) => {
        h.status.progress = null
      }
    ],
    [
      'the answers are not in yet',
      (h) => {
        h.status.progress!.ready = false
      }
    ],
    [
      'the progress has no id',
      (h) => {
        h.status.progress!.id = ''
      }
    ],
    [
      'the progress is for another revision',
      (h) => {
        h.status.progress!.revision = 2
      }
    ],
    [
      'the page has a newer revision',
      (h) => {
        h.status.artifact.revision = 2
      }
    ],
    [
      'the owner named themselves on the study and has not answered yet',
      (h) => {
        h.status.artifact.review = { ...h.status.artifact.review!, type: 'study' }
        h.status.blind = true
      }
    ],
    [
      'a decision page carries progress',
      (h) => {
        h.status.artifact.review = {
          ...h.status.artifact.review!,
          type: 'decision',
          mode: 'decide'
        }
      }
    ]
  ])('tells nobody and wakes nobody when %s', async (_case, change) => {
    const h = responsesIn()
    h.deps.prepare = vi.fn(async (entry) => ({ entry, woke: true }))
    change(h)
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.prepare).not.toHaveBeenCalled()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it('never wakes the session again while its notice is in flight', async () => {
    const h = responsesIn()
    h.saved().sourceReview.receipt = {
      decisionId: 'ready:launch-plan:1',
      entryId: 'artifact-review:in-flight',
      attempt: 0,
      status: 'uncertain',
      transport: 'codex-queue'
    }
    h.deps.prepare = vi.fn(async (entry) => ({ entry, woke: true }))
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.prepare).not.toHaveBeenCalled()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
  })

  it('ends the wait when its owner closes it done; a decision page closed done is unchanged', async () => {
    const h = responsesIn()
    h.status.artifact.lifecycle = 'done'
    h.deps.closedWithoutDecision = vi.fn(async () => {})
    await deliverSourceArtifactReviews(h.deps)
    expect(h.deps.closedWithoutDecision).toHaveBeenCalledOnce()
    expect(h.deps.enqueue).not.toHaveBeenCalled()
    const decided = nativeReviewHarness()
    decided.status.artifact.lifecycle = 'done'
    decided.deps.closedWithoutDecision = vi.fn(async () => {})
    await deliverSourceArtifactReviews(decided.deps)
    expect(decided.deps.closedWithoutDecision).not.toHaveBeenCalled()
    expect(decided.saved().sourceReview.receipt?.decisionId).toBe('dec_1')
  })
})
