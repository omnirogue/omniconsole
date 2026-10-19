/**
 * The `review` kind: an Approve or Request changes on a review page, for the session that published
 * it. On the publishing computer its share record names the conversation and, once the wait armed,
 * its account, model, effort and folder; the review pass's wake guards run before anything reopens
 * it. OmniOS's binding is the fallback when no share record here names the page, then the page's
 * `choices` sidecar and its publishing transcript (review-unbound-target.ts). A receipt that this
 * exact decision already reached the session settles it as done instead of sending it again.
 */

import { homedir, hostname } from 'node:os'
import { formatSessionReference, type SessionReferenceAgent } from '../../shared/session-reference'
import type { ArtifactCloudService } from '../artifacts/artifact-cloud-service'
import { listArtifactShareRecords } from '../artifacts/artifact-share-record-store'
import { validArtifactSourceReview } from '../artifacts/artifact-source-review'
import type { SourceReviewEntry } from '../artifacts/artifact-source-review-watch'
import {
  reviewPassContext,
  type ReviewPassContext
} from '../artifacts/artifact-review-pass-context'
import { wakeCopyApi } from '../artifacts/review-wake-copy-api'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { locateTranscripts, readTranscriptCwd } from '../session-manage/session-transcript-locate'
import { discoverTranscriptRoots } from '../session-search/session-search-roots'
import { WorkDeliveryHold } from '../work-delivery/work-delivery-claimer-types'
import {
  workDeliveryEstatePaths,
  type WorkDeliveryEstatePaths
} from '../work-delivery/work-delivery-estate-paths'
import type {
  ClaimableDelivery,
  WorkDeliveryAlreadyDelivered,
  WorkDeliveryKindAdapter,
  WorkDeliveryResolution,
  WorkDeliveryTarget
} from '../work-delivery/work-delivery-kind'
import { wakeCopyMayExist } from '../../shared/artifact-review-sleep'
import { organizationFields, restoreForAnswer } from './answer-delivery-target'
import { reviewRespawnBrief } from './review-respawn-brief'
import { cachedChoicesSidecars, choicesDecisionReceipt } from './choices-sidecar'
import {
  reviewPassOutcome,
  reviewPassSent,
  reviewWakeGate,
  runtimeReviewPassQueue
} from './review-delivery-gate'
import { publisherScanner, type PublishingTranscript } from './review-publisher-scan'
import { unboundReviewTarget, type UnboundReviewDeps } from './review-unbound-target'

type ReviewContext = {
  slug?: string
  title?: string
  shareUrl?: string
  decision?: string
  decisionId?: unknown
  executionMode?: string
  deciderUserId?: string
}

export { reviewRespawnBrief } from './review-respawn-brief'

/** `sentByPass`: the review pass queued this decision into the live pane already. */
type ReviewTarget = WorkDeliveryTarget & { sentByPass?: true }

const agentOf = (value: unknown): SessionReferenceAgent | null =>
  value === 'claude' || value === 'codex' ? value : null

/** A pane on this computer runs the conversation now (its own pane, or one it was resumed in). */
async function liveHere(pass: ReviewPassContext, entry: SourceReviewEntry): Promise<boolean> {
  const { paneKey, nativeSessionId } = entry.sourceReview
  const rows = (await pass.wake.readRows()).filter(
    (row) => row.paneKey === paneKey || row.providerSessionId === nativeSessionId
  )
  for (const row of rows) {
    const observed = await pass.wake.observe(row)
    if (observed.verdict === 'live' && observed.state !== 'unknown') {
      return true
    }
  }
  return false
}

/** OmniOS's binding: the conversation the page's publishing session reported. */
async function ownerTarget(
  delivery: ClaimableDelivery,
  runtime: OrcaRuntimeService
): Promise<WorkDeliveryTarget | null> {
  const owner = delivery.owner
  const agent = agentOf(owner?.provider)
  if (!owner?.conversationId || !agent) {
    return null
  }
  return {
    ref: formatSessionReference({ agent, sessionId: owner.conversationId, hostId: 'local' }),
    ...(owner.paneKey ? { paneKey: owner.paneKey } : {}),
    ...(owner.accountId ? { accountId: owner.accountId } : {}),
    ...(owner.model ? { model: owner.model } : {}),
    ...(owner.effort ? { effort: owner.effort } : {}),
    ...(owner.folder ? { folder: owner.folder } : {}),
    ...(await organizationFields(runtime, owner.conversationId)),
    transcript: 'present'
  }
}

/** Test seams; the defaults read this computer's estate folders and transcripts. */
export type ReviewDeliveryOptions = {
  paths?: Pick<WorkDeliveryEstatePaths, 'choicesDir'>
  localHost?: string
  findPublisher?: (slug: string) => Promise<PublishingTranscript | null>
  locate?: (sessionId: string) => Promise<string[]>
}

const receiptDelivered = (evidence: string, ref: string | null): WorkDeliveryAlreadyDelivered => ({
  delivered: 'receipt',
  evidence,
  ref
})

export function reviewDeliveryAdapter(
  service: ArtifactCloudService,
  userDataPath: string,
  options: ReviewDeliveryOptions = {}
): WorkDeliveryKindAdapter {
  const wakeApi = wakeCopyApi(service)
  const sidecarOf = cachedChoicesSidecars((options.paths ?? workDeliveryEstatePaths()).choicesDir)
  const claudeRoots = async () =>
    (await discoverTranscriptRoots({ homeDir: homedir(), appDataDirs: [userDataPath] }))
      .filter((root) => root.agent === 'claude')
      .map((root) => root.dir)
  // Why built once: the scanner's cache keeps a held delivery from rescanning every pass.
  const findPublisher = options.findPublisher ?? publisherScanner(claudeRoots)
  const unboundDeps = (runtime: OrcaRuntimeService): UnboundReviewDeps => ({
    localHost: options.localHost ?? hostname(),
    locate:
      options.locate ??
      (async (sessionId) =>
        (await locateTranscripts('claude', sessionId, { userDataPath }).catch(() => [])).map(
          (entry) => entry.path
        )),
    readCwd: (path) => readTranscriptCwd('claude', path),
    findPublisher,
    organization: (sessionId) => organizationFields(runtime, sessionId)
  })
  const status = async (slug: string) => {
    const read = await service.reviewStatus({ slug })
    return read.status === 'ok' ? read.value : null
  }
  /** The share record and the pass it belongs to, when this computer published the page. */
  const local = (runtime: OrcaRuntimeService, slug: string) => {
    const pass = reviewPassContext(userDataPath, runtime, wakeApi, status)
    const records = pass ? listArtifactShareRecords(pass.profileId, userDataPath, pass.scope) : []
    const found = records.find(
      ([, record]) => record.slug === slug && validArtifactSourceReview(record.sourceReview)
    )
    // Why any record's key: a page published here sits next to its sidecar even without a wait.
    const pagePath = (found ?? records.find(([, record]) => record.slug === slug))?.[0]
    if (!pass || !found) {
      return { hit: null, pagePath }
    }
    const [sourceKey, record] = found
    const entry: SourceReviewEntry = { sourceKey, slug, sourceReview: record.sourceReview! }
    return { hit: { pass, entry, sleep: pass.sleepOf(entry) }, pagePath }
  }
  return {
    kind: 'review',
    confirmByTranscript: true,
    resolve: async (delivery, runtime): Promise<ReviewTarget | WorkDeliveryResolution> => {
      const context = delivery.context as ReviewContext
      const slug = typeof context.slug === 'string' && context.slug ? context.slug : null
      if (!slug) {
        return ownerTarget(delivery, runtime)
      }
      const { hit, pagePath } = local(runtime, slug)
      const sidecar = await sidecarOf(slug, pagePath)
      // Why first: the asking session already has this exact decision, so it is never sent twice.
      const receipt = choicesDecisionReceipt(sidecar, context.decisionId)
      if (receipt) {
        return receiptDelivered(receipt, null)
      }
      if (!hit) {
        return (
          (await ownerTarget(delivery, runtime)) ??
          (await unboundReviewTarget(slug, sidecar, unboundDeps(runtime)))
        )
      }
      const { pass, entry, sleep } = hit
      if (
        context.executionMode === 'takeover' &&
        typeof context.deciderUserId === 'string' &&
        context.deciderUserId !== pass.scope.cloudUserId &&
        sleep &&
        wakeCopyMayExist(sleep)
      ) {
        const decidedMs = delivery.eventAt ? Date.parse(delivery.eventAt) : Number.NaN
        if (!Number.isFinite(decidedMs) || pass.wake.now() - decidedMs < 120_000) {
          throw new WorkDeliveryHold(
            'unverifiable',
            'The reviewer chose Take Over; their computer has priority to claim the wake copy.'
          )
        }
      }
      if (!pass.unchanged(entry)) {
        throw new WorkDeliveryHold(
          'busy',
          'Its session is being closed or the signed-in account changed; it is tried again shortly.'
        )
      }
      const sessionId = entry.sourceReview.nativeSessionId
      // Why the queue entry: a send proven never to have left is the claimer's to make.
      const outcome = await reviewPassOutcome(
        entry,
        context.decisionId,
        runtimeReviewPassQueue(runtime),
        () => liveHere(pass, entry)
      )
      if (typeof outcome !== 'string') {
        const sent = entry.sourceReview.receipt
        // Why done: the review pass's queue entry settled delivered for this very decision.
        if (sent?.status === 'delivered' && reviewPassSent(entry, context.decisionId)) {
          const evidence = `the review pass delivered decision ${sent.decisionId} (queue entry ${sent.entryId})`
          return receiptDelivered(evidence, null)
        }
        throw new WorkDeliveryHold(outcome.reason, outcome.message)
      }
      const sentByPass = outcome === 'follow'
      if (!sentByPass && (delivery.state === 'claimed' || delivery.state === 'typed')) {
        if (
          !(await liveHere(pass, entry)) &&
          runtime.getStatus?.()?.desktopWindowStatus !== undefined &&
          runtime.getStatus().desktopWindowStatus !== 'available'
        ) {
          throw new WorkDeliveryHold(
            'no_window',
            'It reopens when the OmniConsole window is open on this computer.'
          )
        }
        const gate = await reviewWakeGate(pass.wake, entry, sleep, delivery.key)
        if (!gate.go) {
          throw new WorkDeliveryHold(gate.reason, gate.message)
        }
      }
      let agent = agentOf(sleep?.provider) ?? agentOf(delivery.owner?.provider)
      if (!agent) {
        const row = (await pass.wake.readRows()).find((r) => r.providerSessionId === sessionId)
        agent = agentOf(row?.agent)
      }
      if (!agent) {
        return null
      }
      const owner = delivery.owner
      const accountId = sleep?.accountHome ?? owner?.accountId
      const model = sleep?.model ?? owner?.model
      const effort = sleep?.effort ?? owner?.effort
      const folder = sleep?.workspace?.path ?? sleep?.cwd ?? owner?.folder
      return {
        ref: formatSessionReference({ agent, sessionId, hostId: 'local' }),
        paneKey: entry.sourceReview.paneKey,
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(folder ? { folder } : {}),
        ...(await organizationFields(runtime, sessionId)),
        ...(sentByPass ? { sentByPass: true } : {}),
        transcript: 'present'
      }
    },
    text: (delivery) => delivery.text,
    respawnBrief: (delivery) => reviewRespawnBrief(delivery),
    restoreDeleted: restoreForAnswer(userDataPath),
    // The review pass already queued this decision into the live pane: follow it, never resend.
    deliverLive: async (_delivery, target: ReviewTarget) =>
      target.sentByPass ? 'typed' : 'not_open'
  }
}
