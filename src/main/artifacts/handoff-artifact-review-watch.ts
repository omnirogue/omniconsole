import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import type { ArtifactCloudOperation } from '../../shared/artifacts'
import type {
  HandoffDetail,
  HandoffReceipt,
  HandoffRespond
} from '../../shared/console-handoff-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  artifactReviewAnswer,
  artifactReviewDecisionEntry,
  artifactReviewDecisionOperationId,
  handoffOpenedAt,
  normalizeHandoffArtifactReview,
  type HandoffArtifactReview
} from '../../shared/handoff-artifact-review'
import { writeSecureJsonFile } from '../../shared/secure-file'

/**
 * Back to the sender: when the person decides on the page, the decision is posted into the
 * handoff thread from the SENDER's desktop, as the sender, with the sender's own bearer reading the
 * page's review (`GET /v1/artifacts/{slug}/review`). Nothing here decides anything; it only reads a
 * decision a person made on the signed-in page and writes it where the sender is waiting.
 *
 * An approval is posted as `done`, which resolves the thread and clears the sender's Waiting for.
 * A change request or rejection is posted as a `reply` and the thread stays open, so the existing
 * re-ask loop asks again on the fixed version (`handoff-artifact-review.ts`).
 *
 * Only threads this desktop sent are watched (they are remembered at send time), and only while
 * the person who sent them is the one signed in. Each post carries a key derived from the thread
 * and the decision, so a restart or an overlapping pass replays the same entry, never a second one.
 * Polling is the whole transport for now; push notices can replace the timer later.
 */

export const HANDOFF_ARTIFACT_REVIEW_POLL_MS = 60_000
/** A thread nobody decided on in this long stops being polled; the page and thread remain. */
const WATCH_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000
const WATCH_MAX_ENTRIES = 200
/** Consecutive "not found / not yours" reads before a thread is let go. */
const MISSING_READS_MAX = 3

export type WatchedArtifactReview = {
  threadId: string
  review: HandoffArtifactReview
  /** Who the request went to, by employee id. */
  recipient: string
  /** Who sent it, by employee id; only that person's session posts into the thread. */
  sender: string
  addedAt: number
  /** Page decisions already posted into the thread. */
  posted: string[]
  missing?: number
}

export type HandoffArtifactReviewWatchStore = {
  load: () => WatchedArtifactReview[]
  save: (entries: WatchedArtifactReview[]) => void
}

export type HandoffArtifactReviewWatchDeps = {
  store: HandoffArtifactReviewWatchStore
  principal: () => Promise<string | null>
  getThread: (args: { threadId: string }) => Promise<ConsoleWorkflowResult<HandoffDetail>>
  respond: (args: HandoffRespond) => Promise<ConsoleWorkflowResult<HandoffReceipt>>
  reviewStatus: (slug: string) => Promise<ArtifactCloudOperation<ArtifactReviewStatus>>
  now?: () => number
  sourceReviews?: () => Promise<void>
}

/** The entry with its missing-read count cleared: the thread answered this time. */
function settled(entry: WatchedArtifactReview): WatchedArtifactReview {
  const { missing: _missing, ...kept } = entry
  return kept
}

function normalizeWatched(value: unknown): WatchedArtifactReview | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  const review = normalizeHandoffArtifactReview(raw.review)
  const threadId = typeof raw.threadId === 'string' ? raw.threadId : ''
  const recipient = typeof raw.recipient === 'string' ? raw.recipient : ''
  const sender = typeof raw.sender === 'string' ? raw.sender : ''
  const addedAt = typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0
  if (!review || !/^hth_[A-Za-z0-9_-]{1,128}$/.test(threadId) || !recipient || !sender) {
    return null
  }
  const posted = Array.isArray(raw.posted)
    ? raw.posted.filter((id): id is string => typeof id === 'string').slice(-50)
    : []
  const missing = typeof raw.missing === 'number' && raw.missing > 0 ? raw.missing : undefined
  return {
    threadId,
    review,
    recipient,
    sender,
    addedAt,
    posted,
    ...(missing ? { missing } : {})
  }
}

/** The file-backed store: one small JSON list beside the app's other local records. */
export function fileHandoffArtifactReviewWatchStore(
  userDataPath: string
): HandoffArtifactReviewWatchStore {
  const path = join(userDataPath, 'handoff-artifact-reviews.json')
  return {
    load: () => {
      try {
        if (!existsSync(path)) {
          return []
        }
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown }
        return (Array.isArray(raw.entries) ? raw.entries : [])
          .map(normalizeWatched)
          .filter((entry): entry is WatchedArtifactReview => entry !== null)
      } catch {
        return []
      }
    },
    save: (entries) => writeSecureJsonFile(path, { version: 1, entries })
  }
}

export class HandoffArtifactReviewWatch {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null

  constructor(private readonly deps: HandoffArtifactReviewWatchDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Remember a thread just sent with a page for review. */
  track(input: {
    threadId: string
    review: HandoffArtifactReview
    recipient: string
    sender: string
  }): void {
    const entries = this.deps.store.load().filter((entry) => entry.threadId !== input.threadId)
    entries.push({ ...input, addedAt: this.now(), posted: [] })
    this.deps.store.save(entries.slice(-WATCH_MAX_ENTRIES))
  }

  watching(): WatchedArtifactReview[] {
    return this.deps.store.load()
  }

  start(intervalMs = HANDOFF_ARTIFACT_REVIEW_POLL_MS): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One pass over every watched thread; overlapping calls share the pass in flight. */
  tick(): Promise<void> {
    this.running ??= Promise.allSettled([this.pass(), this.deps.sourceReviews?.()])
      .then(() => {})
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async pass(): Promise<void> {
    const initial = this.deps.store.load()
    if (!initial.length) {
      return
    }
    const principal = await this.deps.principal().catch(() => null)
    if (!principal) {
      return
    }
    const now = this.now()
    const outcomes = new Map<string, WatchedArtifactReview | null>()
    for (const entry of initial) {
      if (entry.sender !== principal) {
        continue
      }
      if (now - entry.addedAt > WATCH_MAX_AGE_MS) {
        outcomes.set(entry.threadId, null)
        continue
      }
      try {
        outcomes.set(entry.threadId, await this.visit(entry, principal))
      } catch {
        // A pass that fails for one thread leaves it as it was; the next pass asks again.
      }
    }
    if (!outcomes.size) {
      return
    }
    // Why re-read: a send may have been tracked while this pass was waiting on the network.
    const latest = this.deps.store.load()
    this.deps.store.save(
      latest.flatMap((entry) => {
        if (!outcomes.has(entry.threadId)) {
          return [entry]
        }
        const next = outcomes.get(entry.threadId)
        return next ? [next] : []
      })
    )
  }

  /** The entry after one look at its thread and page; null once there is nothing left to watch. */
  private async visit(
    entry: WatchedArtifactReview,
    principal: string
  ): Promise<WatchedArtifactReview | null> {
    const read = await this.deps.getThread({ threadId: entry.threadId })
    if (!read.ok) {
      const status = read.error.status ?? 0
      if (status === 403 || status === 404) {
        const missing = (entry.missing ?? 0) + 1
        return missing >= MISSING_READS_MAX ? null : { ...entry, missing }
      }
      return entry
    }
    const { thread, entries } = read.data
    // The sender alone speaks for their own request; anything else is not this watch's thread.
    if (thread.author_employee_id !== principal || thread.id !== entry.threadId) {
      return null
    }
    if (thread.state === 'resolved' || thread.archived) {
      return null
    }
    const status = await this.deps.reviewStatus(entry.review.slug)
    if (status.status !== 'ok') {
      return settled(entry)
    }
    const answer = artifactReviewAnswer(status.value, handoffOpenedAt(entries))
    const decisionId = answer ? String(answer.id) : null
    if (!answer || !decisionId || entry.posted.includes(decisionId)) {
      return settled(entry)
    }
    const post = artifactReviewDecisionEntry(answer, 'The reviewer')
    const result = await this.deps.respond({
      threadId: entry.threadId,
      kind: post.kind,
      note: post.body,
      operationId: artifactReviewDecisionOperationId(entry.threadId, decisionId)
    })
    if (!result.ok) {
      return settled(entry)
    }
    // An approval resolved the thread: nothing is left to wait for.
    if (post.kind === 'done') {
      return null
    }
    return { ...settled(entry), posted: [...entry.posted, decisionId].slice(-50) }
  }
}
