import { isFollowUpReask, sendFollowUpReask } from './session-follow-up-reask-delivery'
import type { SessionFollowUpRecipient, SessionFollowUpRule } from './session-follow-up-rule'
import {
  errorText,
  FollowUpException,
  type FollowUpDeliveryContext
} from './session-follow-up-delivery-contract'
import { cardlessAttachments, sendCardlessWithFiles } from './session-follow-up-cardless-delivery'
import {
  artifactReviewNote,
  artifactReviewThreadTitle,
  type HandoffArtifactReview
} from './handoff-artifact-review'
import {
  deliverFollowUpAgents,
  requireFollowUpAgentEndpoints
} from './session-follow-up-agent-delivery'

export { errorText, FollowUpException } from './session-follow-up-delivery-contract'
export type {
  FollowUpDeliveryContext,
  FollowUpHostIo,
  FollowUpHubIo
} from './session-follow-up-delivery-contract'

/**
 * The delivery half of a saved follow-up, free of UI and store: find the final files,
 * capture their exact bytes once, attach them to the task, then send one request per
 * person with that person's persisted operation id. Every effect is preceded by a
 * save, so a restart or a duplicate run replays the same request, never a second one.
 */
export {
  captureFollowUpFiles,
  resolveFollowUpFiles,
  type FollowUpCapture
} from './session-follow-up-capture'

const REPLAY_DELAYS_MS = [2_000, 5_000] as const

/**
 * The request fields a page review changes: the recipient's Needs you reads "Review: <title>", the
 * ask is a review, and the note carries the page link for readers that predate the reference.
 */
function artifactReviewRequest(
  review: HandoffArtifactReview,
  note: string
): { title: string; action: 'review'; note: string; artifactReview: HandoffArtifactReview } {
  return {
    title: artifactReviewThreadTitle(review),
    action: 'review',
    note: review.url ? artifactReviewNote(note, review.url) : note,
    artifactReview: review
  }
}

function withRecipient(
  rule: SessionFollowUpRule,
  employeeId: string,
  patch: Partial<SessionFollowUpRecipient>
): SessionFollowUpRule {
  return {
    ...rule,
    recipients: rule.recipients.map((recipient) =>
      recipient.employeeId === employeeId ? { ...recipient, ...patch } : recipient
    )
  }
}

async function uploadPins(
  ctx: FollowUpDeliveryContext,
  start: SessionFollowUpRule & { taskId: string }
): Promise<SessionFollowUpRule | null> {
  let rule = start
  for (const pin of start.files ?? []) {
    if (pin.taskPath) {
      continue
    }
    if (!ctx.current()) {
      return null
    }
    // Why: a re-read after a restart carries the source's own name; the package name is the pin's.
    const file = { ...(await ctx.bytes(pin)), name: pin.name }
    if (file.sha256 !== pin.sha256 || file.size !== pin.size) {
      throw new FollowUpException('files-changed', pin.name)
    }
    let saved: { path: string; sha256: string }
    try {
      saved = await ctx.hub.upload(rule.taskId, file)
    } catch (error) {
      throw new FollowUpException('upload-failed', pin.name, errorText(error))
    }
    if (saved.sha256 !== pin.sha256) {
      throw new FollowUpException('files-changed', pin.name)
    }
    rule = {
      ...rule,
      files: (rule.files ?? []).map((entry) =>
        entry.name === pin.name ? { ...entry, taskPath: saved.path } : entry
      )
    }
    await ctx.save(rule)
  }
  return rule
}

type SendOutcome =
  | { kind: 'sent'; threadId: string }
  | { kind: 'rejected'; error: string }
  | { kind: 'unconfirmed'; error: string }

async function sendWithReplay(
  ctx: FollowUpDeliveryContext,
  send: () => Promise<{ thread_id?: string }>
): Promise<SendOutcome> {
  let lastError = ''
  for (let attempt = 0; attempt <= REPLAY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await ctx.sleep(REPLAY_DELAYS_MS[attempt - 1]!)
      // Why: a cancel during the pause stops replays; the earlier attempt may still have landed.
      if (!ctx.current()) {
        return { kind: 'unconfirmed', error: lastError }
      }
    }
    try {
      const receipt = await send()
      if (receipt.thread_id) {
        return { kind: 'sent', threadId: receipt.thread_id }
      }
      lastError = 'The hub answered without a thread.'
    } catch (error) {
      if (ctx.hub.isRejected(error)) {
        return { kind: 'rejected', error: errorText(error) }
      }
      lastError = errorText(error)
    }
  }
  return { kind: 'unconfirmed', error: lastError }
}

/** Upload the captured pins, then send each person's request once; resolves `stopped` on cancel. */
export async function deliverSessionFollowUp(
  ctx: FollowUpDeliveryContext
): Promise<'delivered' | 'stopped'> {
  const start = ctx.current()
  if (!start) {
    return 'stopped'
  }
  await requireFollowUpAgentEndpoints(ctx, start)
  // Why: a card owns its versions, so they are uploaded once and pinned; a card-less request
  // has no card to upload to, so each person's thread receives the exact bytes itself.
  const taskId = start.taskId
  const cardless = taskId === null || start.recipients.length === 0
  const hasOpening = start.recipients.some(
    (target) => target.delivery !== 'sent' && !isFollowUpReask(ctx, start, target)
  )
  const uploaded = cardless || !hasOpening ? start : await uploadPins(ctx, { ...start, taskId })
  if (!uploaded) {
    return 'stopped'
  }
  let rule = uploaded
  const fileVersions = cardless
    ? []
    : (rule.files ?? []).map((pin) => ({ path: pin.taskPath!, sha256: pin.sha256 }))
  const attachments =
    (cardless && hasOpening) || rule.agentRecipients?.length
      ? await cardlessAttachments(ctx, rule)
      : null
  if (((cardless && hasOpening) || rule.agentRecipients?.length) && !attachments) {
    return 'stopped'
  }
  const rejected: SessionFollowUpRecipient[] = []
  const unconfirmed: SessionFollowUpRecipient[] = []
  for (const target of uploaded.recipients) {
    if (target.delivery === 'sent') {
      continue
    }
    if (!ctx.current()) {
      return 'stopped'
    }
    rule = withRecipient(rule, target.employeeId, {
      delivery: 'sending',
      at: ctx.now(),
      error: undefined
    })
    await ctx.save(rule)
    // Why: a cancel that landed while the marker was saved still wins; nothing has left yet.
    if (!ctx.current()) {
      await ctx.save(withRecipient(rule, target.employeeId, { delivery: target.delivery }))
      return 'stopped'
    }
    // Why: a capture from before readable names called its summary after the request key.
    const summaryName =
      rule.summaryFile ??
      `session-${rule.recipients[0]?.operationId ?? rule.agentRecipients?.[0]?.operationId}.md`
    const pins = rule.files ?? []
    const transcriptPin = pins.find((pin) => pin.generatedKind === 'transcript')
    const common = {
      title: (rule.request?.title ?? rule.taskTitle).slice(0, 160),
      recipient: target.employeeId,
      action: rule.action,
      ...(rule.disposition ? { disposition: rule.disposition } : {}),
      ...(pins.some((pin) => pin.name === summaryName) ? { summaryFile: summaryName } : {}),
      ...(transcriptPin ? { transcriptFile: transcriptPin.name } : {}),
      ...(rule.communicationType ? { communicationType: rule.communicationType } : {}),
      note: rule.request?.description ?? rule.note,
      ...(rule.dueAt ? { dueAt: rule.dueAt } : {}),
      operationId: target.operationId,
      // Why last: a page sent for review is titled, asked and linked as that review.
      ...(rule.artifactReview
        ? artifactReviewRequest(rule.artifactReview, rule.request?.description ?? rule.note)
        : {})
    }
    const cardId = rule.taskId
    const reask = isFollowUpReask(ctx, rule, target)
    const outcome = await sendWithReplay(ctx, () =>
      reask
        ? sendFollowUpReask(ctx, rule, target)
        : cardId === null
          ? sendCardlessWithFiles(ctx, common, attachments ?? [])
          : ctx.hub.send({ ...common, taskId: cardId, fileVersions })
    )
    // Why: the request left; its outcome is recorded even when the rule was cancelled meanwhile.
    rule = ctx.current() ?? rule
    rule =
      outcome.kind === 'sent'
        ? withRecipient(rule, target.employeeId, {
            delivery: 'sent',
            threadId: outcome.threadId,
            at: ctx.now(),
            ...(!reask && rule.disposition === 'ownership-transfer'
              ? { ownershipTransferredAt: ctx.now() }
              : {}),
            error: undefined
          })
        : withRecipient(rule, target.employeeId, {
            delivery: outcome.kind === 'rejected' ? 'failed' : 'sending',
            error: outcome.error,
            at: ctx.now()
          })
    await ctx.save(rule)
    if (outcome.kind === 'rejected') {
      rejected.push({ ...target, error: outcome.error })
    } else if (outcome.kind === 'unconfirmed') {
      unconfirmed.push({ ...target, error: outcome.error })
    }
  }
  const names = (people: SessionFollowUpRecipient[]) =>
    people.map((person) => person.name).join(', ')
  if (rejected.length > 0) {
    throw new FollowUpException('rejected', names(rejected), rejected[0]!.error ?? '')
  }
  if (unconfirmed.length > 0) {
    throw new FollowUpException('unconfirmed', names(unconfirmed), unconfirmed[0]!.error ?? '')
  }
  return deliverFollowUpAgents(ctx, attachments ?? [])
}
