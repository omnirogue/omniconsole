import type { SessionReviewReceipt } from './session-chain-review'
import type { SessionChain, SessionChainAgentStep } from './session-chain-types'
import type { SessionOutcomeWorkflow } from './session-outcome-workflow'

/**
 * What a reviewer seat is actually doing. Lifecycle states are distinct from verdicts:
 * a refusal before launch, a worker failure after it, and an unverifiable attempt are
 * three different answers, and none of them is "waiting".
 */
export type SessionReviewerVerdictStatus =
  | 'pending'
  | 'running'
  | 'unverifiable'
  | 'blocked'
  | 'failed'
  | 'pass'
  | 'findings'

export type SessionReviewerVerdictRow = {
  reviewerId: string
  agent: string
  model: string | null
  status: SessionReviewerVerdictStatus
  blockingFindings: string[]
  notes: string | null
}

export type SessionReviewRoundSummary = {
  /** Host review group id, or the admitted hub stage key. */
  groupId: string
  /** The workflow generation this round belongs to; an amendment never overwrites an earlier one. */
  generationId: string
  /** A later generation has replaced this plan, but its verdicts remain history. */
  superseded: boolean
  source: 'host' | 'hub'
  round: number
  reviewers: SessionReviewerVerdictRow[]
}

type ReviewStep = SessionChainAgentStep & { review: NonNullable<SessionChainAgentStep['review']> }

type SummaryChain = Pick<SessionChain, 'steps' | 'reviewLoop' | 'outcomeSet'>

const HOST_GENERATION = 'host'

/**
 * The row's vocabulary is older than the verdict envelope's: a failed check reads as "changes
 * requested" and a verifier that could not judge reads as "could not review". A row of its own for
 * each is WP-7's, not a silent widening of a status the UI switches on exhaustively.
 */
function rowStatus(status: SessionReviewReceipt['status']): SessionReviewerVerdictStatus {
  if (status === 'crashed' || status === 'insufficient_evidence') {
    return 'failed'
  }
  return status === 'fail' ? 'findings' : status
}

/** What this seat's last real attempt says, when no verdict receipt exists yet. */
function reviewerAttemptState(
  chain: SummaryChain,
  stepId: string
): { status: SessionReviewerVerdictStatus; notes: string | null } | null {
  const attempt = chain.outcomeSet?.attempts?.findLast(
    (entry) => entry.actionId === `step_${stepId}` && entry.state !== 'retryable'
  )
  if (!attempt) {
    return null
  }
  const notes = attempt.error ?? null
  if (['prepared', 'launching', 'running'].includes(attempt.state)) {
    return { status: 'running', notes }
  }
  if (attempt.state === 'unverifiable') {
    return { status: 'unverifiable', notes }
  }
  if (attempt.state === 'blocked') {
    // Refused before the worker ever started, or died after it did.
    return { status: attempt.launchDisposition === 'not-started' ? 'blocked' : 'failed', notes }
  }
  return null
}

function hostRounds(chain: SummaryChain): SessionReviewRoundSummary[] {
  const seats = (chain.steps ?? []).filter(
    (step): step is ReviewStep => step.kind !== 'handoff' && Boolean(step.review)
  )
  const groupIds = [...new Set(seats.map((step) => step.review.groupId))]
  return groupIds.flatMap((groupId) => {
    const loop = chain.reviewLoop?.groups.find((group) => group.id === groupId)
    const rounds = [
      ...new Set([
        ...(loop?.rounds.map((round) => round.index) ?? []),
        ...(loop?.status === 'reviewing' || !loop ? [loop?.currentRound ?? 1] : [])
      ])
    ].sort((left, right) => left - right)
    return rounds.flatMap((round) => {
      const receipts = loop?.rounds.find((entry) => entry.index === round)?.receipts ?? []
      const reviewers = seats
        .filter((step) => step.review.groupId === groupId && step.review.round === round)
        .map((step): SessionReviewerVerdictRow => {
          const receipt = receipts.find((entry) => entry.reviewerId === step.review.reviewerId)
          const attempt = receipt ? null : reviewerAttemptState(chain, step.id)
          return {
            reviewerId: step.review.reviewerId,
            agent: step.agent,
            model: step.model ?? null,
            status: receipt ? rowStatus(receipt.status) : (attempt?.status ?? 'pending'),
            blockingFindings: receipt?.blockingFindings ?? [],
            notes: receipt?.notes ?? attempt?.notes ?? null
          }
        })
      return reviewers.length
        ? [
            {
              groupId,
              generationId: HOST_GENERATION,
              superseded: false,
              source: 'host' as const,
              round,
              reviewers
            }
          ]
        : []
    })
  })
}

/** Every generation, oldest first: an amended workflow moves admitted review stages into history. */
function hubRounds(workflows: readonly SessionOutcomeWorkflow[]): SessionReviewRoundSummary[] {
  return workflows.flatMap((workflow, index) => {
    const rounds = new Map<string, SessionReviewRoundSummary>()
    collectHubRounds(
      workflow,
      workflow.operationId ?? `generation-${index}`,
      index < workflows.length - 1,
      rounds
    )
    return [...rounds.values()].sort(
      (left, right) => left.groupId.localeCompare(right.groupId) || left.round - right.round
    )
  })
}

function collectHubRounds(
  workflow: SessionOutcomeWorkflow,
  generationId: string,
  superseded: boolean,
  rounds: Map<string, SessionReviewRoundSummary>
): void {
  for (const node of workflow.preview.graph.nodes) {
    const stage = node.loop_stage
    if (
      node.action !== 'review' ||
      stage?.role !== 'participant' ||
      typeof stage.stage_key !== 'string' ||
      typeof stage.round !== 'number'
    ) {
      continue
    }
    const key = `${generationId}:${stage.stage_key}:${stage.round}`
    const summary = rounds.get(key) ?? {
      groupId: stage.stage_key,
      generationId,
      superseded,
      source: 'hub' as const,
      round: stage.round,
      reviewers: []
    }
    const verdict = workflow.receipts?.find((receipt) => receipt.key === node.key)?.verdict
    const row: SessionReviewerVerdictRow = {
      reviewerId:
        typeof stage.participant_id === 'string'
          ? stage.participant_id
          : `${node.provider}:${node.model}`,
      agent: node.provider ?? 'agent',
      model: node.model ?? null,
      status: !verdict ? 'pending' : verdict.verdict === 'agree' ? 'pass' : 'findings',
      blockingFindings: verdict?.blockers ?? [],
      notes: verdict?.notes || null
    }
    const earlier = summary.reviewers.findIndex((entry) => entry.reviewerId === row.reviewerId)
    if (earlier === -1) {
      summary.reviewers.push(row)
    } else if (row.status !== 'pending' || summary.reviewers[earlier]!.status === 'pending') {
      summary.reviewers[earlier] = row
    }
    rounds.set(key, summary)
  }
}

/**
 * Per-round, per-reviewer verdicts for a session's outcome plan: host review loops from
 * `chain.reviewLoop`, admitted hub loops from every workflow generation's stage receipts.
 */
export function summarizeSessionReviewRounds(
  chain: SummaryChain | null | undefined
): SessionReviewRoundSummary[] {
  if (!chain) {
    return []
  }
  const workflows = [
    ...(chain.outcomeSet?.workflowHistory ?? []),
    ...(chain.outcomeSet?.workflow ? [chain.outcomeSet.workflow] : [])
  ]
  return workflows.length ? hubRounds(workflows) : hostRounds(chain)
}
