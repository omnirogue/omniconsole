/**
 * The `review` kind: an Approve or Request changes on a review page, for the session that published
 * it. On the publishing computer its share record names the conversation and, once the wait armed,
 * its account, model, effort and folder; the review pass's wake guards run before anything reopens
 * it. OmniOS's binding is the fallback when no share record here names the page.
 */

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
import { WorkDeliveryHold } from '../work-delivery/work-delivery-claimer-types'
import type {
  ClaimableDelivery,
  WorkDeliveryKindAdapter,
  WorkDeliveryTarget
} from '../work-delivery/work-delivery-kind'
import { wakeCopyMayExist } from '../../shared/artifact-review-sleep'
import { organizationFields, restoreForAnswer } from './answer-delivery-target'
import { reviewPassOutcome, reviewWakeGate, runtimeReviewPassQueue } from './review-delivery-gate'

type ContinuationCapsule = {
  goal?: string
  objective?: string
  summary?: string
  repo?: string
  branch?: string
  commit?: string
  head_sha?: string
  files?: string[]
  touchedFiles?: string[]
  touched_files?: string[]
  verify?: string[] | string
  verificationCommands?: string[] | string
  verification_cmd?: string
  next_steps?: string[] | string
  nextSteps?: string[] | string
  next_step_on_approve?: string
  next_step_on_change?: string
}

type ReviewContext = {
  slug?: string
  title?: string
  shareUrl?: string
  decision?: string
  decisionId?: unknown
  executionMode?: string
  deciderUserId?: string
  continuationCapsule?: ContinuationCapsule
}

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

const asList = (value: string[] | string | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0
      ? [value.trim()]
      : []

function formatContinuationCapsule(capsule: ContinuationCapsule | undefined): string {
  if (!capsule || typeof capsule !== 'object') {
    return ''
  }
  const lines: string[] = ['Continuation Capsule:']
  const goal = capsule.goal ?? capsule.objective
  if (goal) {
    lines.push(`- Goal: ${goal}`)
  }
  if (capsule.summary) {
    lines.push(`- Summary: ${capsule.summary}`)
  }
  const commit = capsule.commit ?? capsule.head_sha
  if (capsule.repo || capsule.branch || commit) {
    lines.push(`- Git: ${[capsule.repo, capsule.branch, commit].filter(Boolean).join(' @ ')}`)
  }
  const files = capsule.files ?? capsule.touchedFiles ?? capsule.touched_files
  if (Array.isArray(files) && files.length > 0) {
    lines.push(`- Files: ${files.join(', ')}`)
  }
  const verify = asList(capsule.verify ?? capsule.verificationCommands ?? capsule.verification_cmd)
  if (verify.length > 0) {
    lines.push(`- Verify: ${verify.join(' && ')}`)
  }
  const next = asList(
    capsule.next_steps ??
      capsule.nextSteps ??
      [capsule.next_step_on_approve, capsule.next_step_on_change].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0
      )
  )
  if (next.length > 0) {
    lines.push(`- Next steps: ${next.join('; ')}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

export function reviewRespawnBrief(delivery: ClaimableDelivery): string {
  const context = delivery.context as ReviewContext
  const page = context.title ? `“${context.title}”` : (context.slug ?? delivery.workItem)
  const capsuleBlock = formatContinuationCapsule(context.continuationCapsule)
  return [
    `You are taking over the work behind the review page ${page}${context.shareUrl ? ` (${context.shareUrl})` : ''}. The session that published it can no longer be reopened (its transcript is gone), so you are its replacement: work in this folder, with this model and effort.`,
    capsuleBlock,
    context.slug
      ? `Read the page and its saved decision first: omni artifacts status ${context.slug} --json`
      : '',
    `The decision that needs you now:\n\n${delivery.text}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function reviewDeliveryAdapter(
  service: ArtifactCloudService,
  userDataPath: string
): WorkDeliveryKindAdapter {
  const wakeApi = wakeCopyApi(service)
  const status = async (slug: string) => {
    const read = await service.reviewStatus({ slug })
    return read.status === 'ok' ? read.value : null
  }
  /** The share record and the pass it belongs to, when this computer published the page. */
  const local = (runtime: OrcaRuntimeService, slug: string) => {
    const pass = reviewPassContext(userDataPath, runtime, wakeApi, status)
    const found = pass
      ? listArtifactShareRecords(pass.profileId, userDataPath, pass.scope).find(
          ([, record]) => record.slug === slug && validArtifactSourceReview(record.sourceReview)
        )
      : undefined
    if (!pass || !found) {
      return null
    }
    const [sourceKey, record] = found
    const entry: SourceReviewEntry = { sourceKey, slug, sourceReview: record.sourceReview! }
    return { pass, entry, sleep: pass.sleepOf(entry) }
  }
  return {
    kind: 'review',
    resolve: async (delivery, runtime): Promise<ReviewTarget | null> => {
      const context = delivery.context as ReviewContext
      const found = typeof context.slug === 'string' ? local(runtime, context.slug) : null
      if (!found) {
        return ownerTarget(delivery, runtime)
      }
      const { pass, entry, sleep } = found
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
