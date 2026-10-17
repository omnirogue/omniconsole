import { sessionOutcomeWorkflowTarget } from './session-outcome-workflow-target'
import type { HandoffDetail } from '../../shared/console-handoff-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import { sessionPersonConditionThread } from '../../shared/session-review-ask'
import { spentSessionReviewReceipts } from '../../shared/session-run-held-continuation'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeVerification } from './session-outcome-evidence'
import type { SessionOutcomeWaitReading } from './session-outcome-event-evidence'
import { verifySessionOutcomeAgentDelivery } from './session-outcome-agent-evidence'
import { artifactReviewConditionReceipt } from './session-outcome-artifact-review'
import { verifySessionOutcomeEvent } from './session-outcome-event-evidence'

let readHandoff:
  | ((args: { threadId: string }) => Promise<ConsoleWorkflowResult<HandoffDetail>>)
  | null = null
export function installSessionOutcomeHandoffReader(reader: NonNullable<typeof readHandoff>): void {
  readHandoff = reader
}

/** The same reader, for a caller that needs a reply's own words; null on a host without one. */
export function sessionOutcomeHandoffReader(): typeof readHandoff {
  return readHandoff
}

/**
 * The captured files the thread must show as current, under the names they were sent with. A
 * same-thread re-ask (its saved plan, `session-follow-up-reask-delivery.ts`) never sends the
 * transcript again and may send a large revision under a round name, so it is held to what it sent.
 */
function threadFilesSent(
  rule: SessionFollowUpRule,
  threadId: string
): { name: string; sha256: string; size: number }[] {
  const recipient = rule.recipients.find((entry) => entry.threadId === threadId)
  const saved = recipient?.reaskPlan
  // Only the plan of the key this round was sent under says what reached the thread.
  const plan =
    rule.reask && saved?.operationId === recipient?.operationId && saved?.threadId === threadId
      ? saved
      : undefined
  return (rule.files ?? []).flatMap((pin, index) =>
    plan && pin.generatedKind === 'transcript'
      ? []
      : [{ ...pin, name: plan?.files.find((item) => item.index === index)?.name ?? pin.name }]
  )
}

/**
 * An approve-only review answered with anything else: the decision is the owner's now — keep
 * waiting, continue anyway, or cancel — never an early start of the work held behind it.
 */
function changesRequested(
  condition: SessionOutcomeCondition,
  chain: SessionChain | undefined,
  owningOutcomeId: string | undefined,
  answerId: string,
  note?: string
): SessionOutcomeVerification & { wait: SessionOutcomeWaitReading } {
  const fact = chain?.outcomeSet?.outcomes
    .find((entry) => entry.id === owningOutcomeId)
    ?.waits?.find((entry) => entry.conditionId === condition.id)
  const name =
    chain?.steps
      .flatMap((step) => (step.kind === 'handoff' ? step.handoff.recipients : []))
      .find((recipient) => recipient.employeeId === condition.recipientId)?.name ??
    condition.recipientId
  // The owner chose to keep waiting after THIS answer: only a new one decides anything.
  if (fact?.rearmedAt !== undefined && fact.answerId === answerId) {
    const reason = `Waiting for a new answer from ${name}.`
    return {
      verified: false,
      reason,
      wait: { status: 'pending', checkedAt: Date.now(), reason, answerId }
    }
  }
  const reason = `${name} asked for changes instead of approving.`
  const excerpt = note?.replace(/\s+/g, ' ').trim().slice(0, 400)
  return {
    verified: false,
    reason,
    wait: {
      status: 'needs_you',
      checkedAt: Date.now(),
      reason,
      answerId,
      ...(excerpt ? { excerpt } : {}),
      ...(name ? { by: name.slice(0, 80) } : {})
    }
  }
}

export async function verifySessionOutcomeExternalCondition(
  condition: SessionOutcomeCondition,
  runtime?: OrcaRuntimeService,
  chain?: SessionChain,
  owningOutcomeId?: string
): Promise<SessionOutcomeVerification> {
  if (condition.kind === 'handoff' && condition.recipientSessionId) {
    return verifySessionOutcomeAgentDelivery(condition, chain)
  }
  if (condition.kind === 'event') {
    const fact = chain?.outcomeSet?.outcomes
      .find((entry) => entry.id === owningOutcomeId)
      ?.waits?.find((entry) => entry.conditionId === condition.id)
    return verifySessionOutcomeEvent(condition, fact, Date.now(), runtime)
  }
  if ((condition.kind === 'pr' || condition.kind === 'merge') && runtime) {
    if (chain?.outcomeSet?.workflow) {
      try {
        const candidate = sessionOutcomeWorkflowTarget(chain, condition, owningOutcomeId).receipt
        condition = {
          ...condition,
          branch: candidate.branch!,
          version: candidate.candidateSha!,
          target: candidate.prUrl!
        }
      } catch (error) {
        return { verified: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!condition.repository || !condition.branch) {
      return {
        verified: false,
        reason: 'Repository and working branch are required for review-request evidence.'
      }
    }
    const match = condition.target.match(/\/(?:pull|merge_requests)\/(\d+)$/)
    const number = match ? Number(match[1]) : undefined
    const result = await runtime.getRepoPRForBranch(
      condition.repository,
      condition.branch,
      number,
      number,
      true,
      condition.version,
      'manual'
    )
    if (result.kind !== 'found') {
      return {
        verified: false,
        reason:
          result.kind === 'upstream-error'
            ? result.message
            : 'The requested review request was not found.'
      }
    }
    const pr = result.pr
    if (
      (condition.version && pr.headSha !== condition.version) ||
      (condition.targetBranch && pr.baseRefName !== condition.targetBranch) ||
      (number && pr.number !== number) ||
      (condition.target.startsWith('https:') && pr.url !== condition.target)
    ) {
      return {
        verified: false,
        reason: 'The review request does not match the committed candidate or target.'
      }
    }
    if (condition.kind === 'merge' && pr.state !== 'merged') {
      return { verified: false, reason: 'The requested candidate has not merged.' }
    }
    if (condition.kind === 'pr' && pr.state !== 'open' && pr.state !== 'merged') {
      return { verified: false, reason: 'The requested review request is closed without merging.' }
    }
    return { verified: true, version: pr.headSha, receipt: `${pr.url}@${pr.headSha}:${pr.state}` }
  }
  if (condition.kind === 'handoff' || (condition.kind === 'review' && condition.recipientId)) {
    if (!readHandoff) {
      return {
        verified: false,
        reason: 'The signed-person handoff transport is unavailable on this host.'
      }
    }
    // A second Review of the same person is answered on ITS thread, never on the first ask's —
    // and only this condition's own Outcome's asks are read, never another Outcome's.
    const threadId = sessionPersonConditionThread(
      chain,
      condition,
      chain?.outcomeSet?.outcomes.find((entry) => entry.id === owningOutcomeId)?.stepIds
    )
    if (!threadId || !condition.recipientId) {
      return {
        verified: false,
        reason: 'An ownership delivery receipt and exact recipient are required.'
      }
    }
    const result = await readHandoff({ threadId })
    if (!result.ok) {
      return { verified: false, reason: result.error.message }
    }
    const { thread, files } = result.data
    if (thread.recipient_employee_id !== condition.recipientId) {
      return {
        verified: false,
        reason: 'The delivery receipt does not cover the requested recipient.'
      }
    }
    if (
      condition.fileVersions?.some(
        (pin) =>
          !files.some(
            (file) =>
              file.path === pin.path && file.sha256 === pin.sha256 && file.current && file.available
          )
      )
    ) {
      return {
        verified: false,
        reason: 'The recipient cannot access the requested current file versions.'
      }
    }
    const deliveredStep = chain?.steps.find(
      (step) =>
        step.kind === 'handoff' &&
        step.handoff.recipients.some((recipient) => recipient.threadId === thread.id)
    )
    if (
      deliveredStep?.kind === 'handoff' &&
      threadFilesSent(deliveredStep.handoff, thread.id).some(
        (pin) =>
          !files.some(
            (file) =>
              file.sha256 === pin.sha256 &&
              file.size === pin.size &&
              file.name === pin.name &&
              file.current &&
              file.available
          )
      )
    ) {
      return {
        verified: false,
        reason: 'The delivery receipt does not expose the requested current file bytes.'
      }
    }
    if (condition.kind === 'review') {
      const current = files.filter((file) => file.current && file.available).map((file) => file.id)
      // A review is a REPLY, not an approval. Only a named recipient's review condition is
      // verified here (the guard above requires `recipientId`), and that one is the feedback
      // disposition: the receipt records the reply either way, and what the run does next reads
      // its decision — only approvals release work held behind the review, and "request changes"
      // goes to the agent first (`up-next-review-fix.ts`). The legacy recipient-less review
      // condition never reaches this verifier — it is the person's OWN review, held by
      // `session-outcome-evidence.ts`, and no hub reply stands in for it.
      const spent = spentSessionReviewReceipts(chain?.outcomeSet?.heldContinuation)
      // A request that carries an omnios page is decided ON the page; that decision is the reply.
      const page = await artifactReviewConditionReceipt(thread.id, result.data.entries, spent)
      if (page) {
        return condition.require === 'approve' && !page.endsWith(':approve')
          ? changesRequested(condition, chain, owningOutcomeId, page)
          : { verified: true, version: condition.version, receipt: page }
      }
      const covering = result.data.reviews.filter(
        (review) =>
          review.current &&
          current.every((id) => review.version_ids.includes(id)) &&
          // An answer to a version a re-ask replaced — approval or not — answers nothing now.
          !spent.has(`handoff-review:${thread.id}:${review.id}:${review.decision}`)
      )
      // The last current review the hub lists for them: a superseded reply is not current,
      // so this is their standing word on these versions.
      const reply = covering.at(-1)
      if (!reply) {
        return {
          verified: false,
          reason: 'The requested person has not returned a review of the current file versions.'
        }
      }
      if (condition.require === 'approve' && reply.decision !== 'approve') {
        return changesRequested(
          condition,
          chain,
          owningOutcomeId,
          `handoff-review:${thread.id}:${reply.id}`,
          reply.note
        )
      }
      return {
        verified: true,
        version: condition.version,
        // The decision travels IN the receipt: what the chain does next may depend on
        // whether the reviewer approved or asked for changes, and nothing downstream
        // should have to ask the hub again to find out.
        receipt: `handoff-review:${thread.id}:${reply.id}:${reply.decision}`
      }
    }
    return {
      verified: true,
      receipt: `handoff:${thread.id}:${thread.delivery_id ?? thread.id}:${thread.recipient_employee_id}`
    }
  }
  return {
    verified: false,
    reason: `No authorized ${condition.kind} receipt verifier is installed on this host.`
  }
}
