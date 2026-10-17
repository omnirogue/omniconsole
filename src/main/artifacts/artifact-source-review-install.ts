import { randomUUID } from 'node:crypto'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { sessionManageSource } from '../session-manage/session-manage-observe'
import { readPaneAgentPresence } from '../runtime/prompt-queue-agent-presence'
import { bindSessionPrompt } from '../runtime/session-prompt-binding'
import { enqueueConversationPrompt } from '../runtime/prompt-queue-enqueue'
import { queueCodexTerminalNotice } from '../runtime/codex-terminal-queue'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ArtifactCloudService } from './artifact-cloud-service'
import {
  listArtifactShareRecords,
  saveArtifactSourceReviewReceipt
} from './artifact-share-record-store'
import { validArtifactSourceReview, type ArtifactSourceReview } from './artifact-source-review'
import { validArtifactReviewSleep, wakeCopyMayExist } from '../../shared/artifact-review-sleep'
import { markReviewDelivered, prepareReviewWake } from './artifact-review-wake'
import { sourceReviewReports } from './artifact-source-review-reports'
import { wakeCopyApi } from './review-wake-copy-api'
import { runWakeClaims } from './review-wake-claimer'
import { reviewPassContext } from './artifact-review-pass-context'
import { leftToClaimer } from '../answer-delivery/answer-delivery-handover'
import { runtimeWakeClaimerDeps } from './review-wake-claimer-runtime'
import { endReviewWaitWithoutDecision, handleReviewReject } from './artifact-review-reject'
import { runtimeReviewCloseDeps, runtimeReviewRejectDeps } from './artifact-review-reject-runtime'
import {
  deliverSourceArtifactReviews,
  type SourceReviewEntry
} from './artifact-source-review-watch'
import {
  findPromptQueueEntry,
  reconcileSourceReviewReceipts
} from './artifact-source-review-receipt'

/** Uses the existing review timer, source ledger and prompt queue; no separate delivery service. */
export function sourceArtifactReviewPass(
  service: ArtifactCloudService,
  userDataPath: string,
  runtime: OrcaRuntimeService
): () => Promise<void> {
  const reports = sourceReviewReports(service, userDataPath, runtime)
  const wakeApi = wakeCopyApi(service)
  const reviewStatus = async (slug: string) => {
    const read = await service.reviewStatus({ slug })
    return read.status === 'ok' ? read.value : null
  }
  // Phase 2: wakes another computer's sleeping session here when its own computer is off.
  const claims = runtimeWakeClaimerDeps({
    runtime,
    api: wakeApi,
    apiOrigin: () => service.apiOrigin(),
    userDataPath,
    reviewStatus
  })
  return async () => {
    await reports.before()
    await deliverPass()
    await reports.after()
    await runWakeClaims(claims).catch(() => {})
  }
  async function deliverPass(): Promise<void> {
    const pass = reviewPassContext(userDataPath, runtime, wakeApi, reviewStatus)
    if (!pass) {
      return
    }
    const { profileId, scope, current, closing, wake, sleepOf } = pass
    let rows: ReturnType<typeof readSidebarRows> | undefined
    const codexSources = new Set<string>()
    const entries = () =>
      listArtifactShareRecords(profileId, userDataPath, scope)
        .filter(([, record]) => validArtifactSourceReview(record.sourceReview))
        .map(([sourceKey, record]) => ({
          sourceKey,
          slug: record.slug,
          sourceReview: record.sourceReview!
        }))
    const saveReceipt = (
      entry: SourceReviewEntry,
      receipt: NonNullable<ArtifactSourceReview['receipt']>
    ): boolean =>
      current(entry) &&
      saveArtifactSourceReviewReceipt(
        profileId,
        userDataPath,
        entry.sourceKey,
        scope,
        entry,
        receipt
      )
    // A receipt follows its prompt-queue entry to delivered or failed once that entry settles.
    try {
      const queues = runtime.listPromptQueues()
      reconcileSourceReviewReceipts({
        entries,
        find: (entryId) => findPromptQueueEntry(queues, entryId),
        save: saveReceipt
      })
    } catch {
      // A receipt that cannot be written now is moved on by the next pass.
    }
    await deliverSourceArtifactReviews({
      entries,
      current,
      status: reviewStatus,
      source: async (entry) => {
        // Why the wake's reader: with no window it falls back to the owner's last listing.
        rows ??= wake.readRows()
        // Why archived too while it waits on this page: archiving it meanwhile is not a Reject.
        const waits = ['waiting', 'asleep', 'waking', 'stalled', 'awake'].includes(
          sleepOf(entry)?.state ?? ''
        )
        const match = (await rows).find(
          (row) =>
            row.paneKey === entry.sourceReview.paneKey &&
            row.worktreeId === entry.sourceReview.worktreeId &&
            !row.hostUnavailable &&
            (!row.archived || waits) &&
            row.providerSessionId === entry.sourceReview.nativeSessionId
        )
        if (match?.agent === 'codex') {
          codexSources.add(entry.sourceKey)
        }
        return match ? sessionManageSource(match) : null
      },
      prepare: async (entry, decision) => {
        const cause = decision ? 'decision' : 'responses'
        const outcome = await prepareReviewWake(wake, entry, sleepOf(entry), cause)
        if (outcome.kind === 'hold') {
          return null
        }
        if (outcome.entry !== entry) {
          // The binding moved to the woken pane; the sidebar listing must be read again.
          rows = undefined
        }
        return { entry: outcome.entry, woke: outcome.woke }
      },
      delivered: (entry) => markReviewDelivered(wake, entry, sleepOf(entry)),
      leftToClaimer: (answer, status) =>
        leftToClaimer('review', answer.deliveryKey, status.delivery),
      closedWithoutDecision: (entry) =>
        endReviewWaitWithoutDecision(
          runtimeReviewCloseDeps({ ...closing, wake }),
          entry,
          sleepOf(entry)
        ),
      reject: (entry, decision) =>
        handleReviewReject(
          runtimeReviewRejectDeps({ ...closing, wake }),
          entry,
          sleepOf(entry),
          decision
        ),
      queued: (source, id) =>
        runtime.readPromptQueue(conversationSourceRowKey(source))?.entries.find((v) => v.id === id),
      save: saveReceipt,
      native: async (entry, source, text, prepare) => {
        if (source.kind !== 'pty') {
          return null
        }
        const terminal = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
        // An SSH controller cannot use the remote pid locally. Keep the existing owner-routed door.
        if (terminal.executionHostId !== 'local') {
          return null
        }
        const presence = await readPaneAgentPresence(runtime, source)
        if (presence.kind !== 'proven' || presence.proof.agent !== 'codex') {
          return codexSources.has(entry.sourceKey)
            ? { status: 'not-started', reason: 'native-writer-unverifiable' }
            : null
        }
        const correlationNonce = randomUUID()
        return queueCodexTerminalNotice({
          terminal,
          proof: presence.proof,
          threadId: entry.sourceReview.nativeSessionId,
          hint: `${text}\nDelivery ID: ${correlationNonce}`,
          correlationNonce,
          prepare: () => prepare(correlationNonce),
          assertCurrent: async () => {
            if (!current(entry)) {
              throw new Error('Publishing source changed')
            }
            await runtime.assertTerminalAgentProcess(presence.proof, terminal.ptyId!)
          }
        })
      },
      enqueue: async (entry, source: ConversationSource, id, text, retryId) => {
        const presence = await readPaneAgentPresence(runtime, source)
        if (!current(entry) || (source.kind === 'pty' && presence.kind !== 'proven')) {
          return false
        }
        const still = () => current(entry)
        bindSessionPrompt(conversationSourceRowKey(source), id, {
          receiver: presence.kind === 'proven' ? presence.proof : null,
          conversationStill: still,
          conversationGuard: async () =>
            still() ? null : 'The publishing conversation or signed-in account changed.'
        })
        if (retryId) {
          const failed = runtime
            .readPromptQueue(conversationSourceRowKey(source))
            ?.entries.find((v) => v.id === retryId)
          if (failed?.state !== 'failed' || failed.unsent !== true) {
            return false
          }
          runtime.removePromptQueueEntry(conversationSourceRowKey(source), retryId)
        }
        enqueueConversationPrompt(runtime, source, {
          id,
          text,
          requestedBy: { action: 'continue', actor: 'artifact-review' }
        })
        return true
      }
    })
    // Phase 2: one another computer woke is given up here on every pass, decision or not.
    for (const [sourceKey, record] of listArtifactShareRecords(profileId, userDataPath, scope)) {
      const { sleep, sourceReview } = record
      if (
        validArtifactSourceReview(sourceReview) &&
        validArtifactReviewSleep(sleep) &&
        (sleep.state === 'asleep' || sleep.state === 'stalled') &&
        wakeCopyMayExist(sleep)
      ) {
        await wake.wakeClaimElsewhere({ sourceKey, slug: record.slug, sourceReview }, sleep)
      }
    }
  }
}
