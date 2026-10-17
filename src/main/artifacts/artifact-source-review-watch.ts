import { createHash } from 'node:crypto'
import {
  artifactLifecycleSnapshot,
  isArtifactCollectAsk,
  type ArtifactReviewDecision,
  type ArtifactReviewProgress,
  type ArtifactReviewStatus
} from '../../shared/artifact-review'
import { artifactDecisionMessage } from '../../shared/artifact-review-decision-message'
import { artifactResponsesInMessage } from '../../shared/artifact-review-responses-message'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { ArtifactSourceReview } from './artifact-source-review'
import type { PeerInboxCodexQueueResult } from '../runtime/peer-inbox-codex-queue'

export type SourceReviewEntry = {
  sourceKey: string
  slug: string
  sourceReview: ArtifactSourceReview
}
export type SourceReviewWatchDeps = {
  entries(): SourceReviewEntry[]
  current(entry: SourceReviewEntry): boolean
  status(slug: string): Promise<ArtifactReviewStatus | null>
  source(entry: SourceReviewEntry): Promise<ConversationSource | null>
  queued(source: ConversationSource, id: string): PromptQueueEntry | undefined
  save(entry: SourceReviewEntry, receipt: NonNullable<ArtifactSourceReview['receipt']>): boolean
  native?(
    entry: SourceReviewEntry,
    source: ConversationSource,
    text: string,
    prepare: (correlationNonce: string) => boolean
  ): Promise<PeerInboxCodexQueueResult | null>
  enqueue(
    entry: SourceReviewEntry,
    source: ConversationSource,
    id: string,
    text: string,
    retryId?: string
  ): Promise<boolean>
  /**
   * Before delivering an approval, a changes request or (null) a review's answers: wakes a session
   * that slept waiting for it and returns the binding it now runs under; null holds it for later.
   */
  prepare?(
    entry: SourceReviewEntry,
    decision: ArtifactReviewDecision | null
  ): Promise<{ entry: SourceReviewEntry; woke: boolean } | null>
  /** The decision, or a review's "responses in", was queued into the conversation. */
  delivered?(entry: SourceReviewEntry): void
  /** OmniOS's answer-delivery claimer delivers this approval or change request, not this pass. */
  leftToClaimer?(decision: ArtifactReviewDecision, status: ArtifactReviewStatus): boolean
  /**
   * A Reject: deletes the session that asked when it may go; `deliver` lets the normal path tell
   * a live one to stop, `done` sends nothing.
   */
  reject?(entry: SourceReviewEntry, decision: ArtifactReviewDecision): Promise<'deliver' | 'done'>
  /**
   * The owner closed (no action, or a review or study as done) or superseded the page with no
   * decision on this revision.
   */
  closedWithoutDecision?(entry: SourceReviewEntry): Promise<void>
}

type SourceReceipt = NonNullable<ArtifactSourceReview['receipt']>

function inFlight(receipt: SourceReceipt | undefined, id: string): boolean {
  return receipt?.decisionId === id && ['sending', 'uncertain'].includes(receipt.status)
}

/**
 * A review or study whose answers are in on the waited revision, still open and undecided, that
 * the owner may read: an owner who named themselves on a study reads none until they answer.
 */
function readyProgress(
  entry: SourceReviewEntry,
  status: ArtifactReviewStatus
): ArtifactReviewProgress | null {
  const { revision } = entry.sourceReview
  const { lifecycle, supersededBy } = artifactLifecycleSnapshot(status)
  const progress = status.progress
  return status.viewer.isOwner &&
    isArtifactCollectAsk(status.artifact.review) &&
    status.blind !== true &&
    status.artifact.slug === entry.slug &&
    status.artifact.revision === revision &&
    status.status === 'pending' &&
    !lifecycle &&
    !supersededBy &&
    progress?.ready === true &&
    typeof progress.id === 'string' &&
    progress.id.length > 0 &&
    progress.revision === revision &&
    status.latest?.revision !== revision
    ? progress
    : null
}

/**
 * Queues one notice per `noticeId` into the conversation (a Codex pane's native queue first) and
 * keeps its receipt, so a pass after a crash or a failed send replays the same queue entry.
 */
async function deliverNotice(
  deps: SourceReviewWatchDeps,
  entry: SourceReviewEntry,
  noticeId: string,
  message: (prior: SourceReceipt | undefined) => string
): Promise<void> {
  const source = await deps.source(entry)
  if (!source || !deps.current(entry)) {
    return
  }
  const prior = entry.sourceReview.receipt
  if (inFlight(prior, noticeId)) {
    return
  }
  const old = prior?.decisionId === noticeId ? deps.queued(source, prior.entryId) : undefined
  // Why settled too: the receipt mirrors a settled entry, and a missing row is never resent.
  if (
    !old &&
    prior?.decisionId === noticeId &&
    ['queued', 'delivered', 'failed'].includes(prior.status)
  ) {
    return
  }
  if (
    old &&
    (old.state === 'sending' ||
      old.state === 'delivered' ||
      (old.state === 'failed' && !old.unsent))
  ) {
    return
  }
  // A saved receipt with no queue row may precede enqueue after a crash: replay its stable id.
  const attempt =
    prior?.decisionId === noticeId
      ? prior.attempt + (old?.state === 'failed' && old.unsent ? 1 : 0)
      : 0
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        entry.slug,
        entry.sourceReview.revision,
        noticeId,
        entry.sourceReview.nativeSessionId,
        conversationSourceRowKey(source),
        attempt
      ])
    )
    .digest('hex')
  const receipt = {
    decisionId: noticeId,
    entryId: `artifact-review:${digest}`,
    attempt,
    status: 'prepared' as const
  }
  if (!deps.save(entry, receipt)) {
    return
  }
  let pinned: SourceReviewEntry = { ...entry, sourceReview: { ...entry.sourceReview, receipt } }
  const text = message(prior)
  const native =
    (!old || (old.state === 'failed' && old.unsent)) &&
    (await deps.native?.(pinned, source, text, (nativeNonce) => {
      const sending = {
        ...receipt,
        status: 'sending' as const,
        transport: 'codex-queue' as const,
        nativeNonce
      }
      if (!deps.current(pinned) || !deps.save(pinned, sending)) {
        return false
      }
      pinned = { ...pinned, sourceReview: { ...pinned.sourceReview, receipt: sending } }
      return true
    }))
  if (native) {
    deps.save(pinned, {
      ...pinned.sourceReview.receipt!,
      transport: 'codex-queue',
      status: native.status === 'not-started' ? 'prepared' : native.status,
      ...(native.status === 'queued'
        ? { nativeItemId: native.nativeItemId }
        : { reason: native.reason })
    })
    if (native.status === 'queued') {
      deps.delivered?.(pinned)
    }
    return
  }
  if (
    await deps.enqueue(
      pinned,
      source,
      receipt.entryId,
      text,
      old?.state === 'failed' && old.unsent ? old.id : undefined
    )
  ) {
    deps.save(pinned, { ...receipt, status: 'queued' })
    deps.delivered?.(pinned)
  }
}

/** Native publishers do not call the MCP connection that the server's notice waits on. */
export async function deliverSourceArtifactReviews(deps: SourceReviewWatchDeps): Promise<void> {
  for (const listed of deps.entries()) {
    let entry = listed
    try {
      if (!deps.current(entry)) {
        continue
      }
      const status = await deps.status(entry.slug)
      const answer = status?.latest
      const lifecycle = status ? artifactLifecycleSnapshot(status) : null
      if (
        deps.closedWithoutDecision &&
        status?.viewer.isOwner &&
        status.artifact.slug === entry.slug &&
        (lifecycle?.lifecycle === 'no_action' ||
          lifecycle?.supersededBy ||
          // Why: a review or study is never decided; its owner closes it done once it is read.
          (lifecycle?.lifecycle === 'done' && isArtifactCollectAsk(status.artifact.review))) &&
        answer?.revision !== entry.sourceReview.revision &&
        deps.current(entry)
      ) {
        await deps.closedWithoutDecision(entry)
        continue
      }
      const progress = status && readyProgress(entry, status)
      if (progress) {
        const noticeId = `ready:${progress.id}`
        // Why no reject path: answers in are never a decision, so this only wakes and tells.
        if (inFlight(entry.sourceReview.receipt, noticeId)) {
          continue
        }
        const prepared = deps.prepare ? await deps.prepare(entry, null) : { entry, woke: false }
        if (!prepared || !deps.current(prepared.entry)) {
          continue
        }
        await deliverNotice(deps, prepared.entry, noticeId, () =>
          artifactResponsesInMessage({
            slug: prepared.entry.slug,
            title: status.artifact.title ?? '',
            shareUrl: status.shareUrl,
            progress,
            study: status.artifact.review?.type === 'study',
            woke: prepared.woke
          })
        )
        continue
      }
      if (
        !deps.current(entry) ||
        !status?.viewer.isOwner ||
        !answer ||
        status.artifact.slug !== entry.slug ||
        status.artifact.revision !== entry.sourceReview.revision ||
        answer.revision !== entry.sourceReview.revision ||
        status.status !== answer.decision ||
        !['approved', 'changes_requested', 'rejected'].includes(answer.decision)
      ) {
        continue
      }
      let woke = false
      // Why first: a send in flight or of unknown outcome is never followed by a wake or a delete.
      if (inFlight(entry.sourceReview.receipt, String(answer.id))) {
        continue
      }
      if (answer.decision !== 'rejected' && deps.leftToClaimer?.(answer, status)) {
        const reached = ['typed', 'working', 'done'].includes(status.delivery?.state ?? '')
        if (reached && status.delivery?.key === answer.deliveryKey) {
          deps.delivered?.(entry)
        }
        continue
      }
      if (
        answer.decision === 'rejected' &&
        deps.reject &&
        (await deps.reject(entry, answer)) === 'done'
      ) {
        continue
      }
      if (answer.decision !== 'rejected' && deps.prepare) {
        const prepared = await deps.prepare(entry, answer)
        if (!prepared || !deps.current(prepared.entry)) {
          continue
        }
        entry = prepared.entry
        woke = prepared.woke
      }
      const decisionId = String(answer.id)
      await deliverNotice(deps, entry, decisionId, (prior) =>
        artifactDecisionMessage({
          slug: entry.slug,
          title: status.artifact.title ?? '',
          shareUrl: status.shareUrl,
          decision: answer,
          woke,
          // Why: a changed decision reaches a session that may already be acting on the first one.
          rejectedWhileWorking:
            answer.decision === 'rejected' && prior !== undefined && prior.decisionId !== decisionId
        })
      )
    } catch {
      // The persisted decision and queue receipt survive network/host loss for the next pass.
    }
  }
}
