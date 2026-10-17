import { createHash } from 'node:crypto'
import {
  lastSessionVerdictReceipt,
  sessionVerdictOfReceipt,
  verdictInvariantProblems
} from '../../shared/session-chain-verdict-receipts'
import type { SessionVerdictStatus } from '../../shared/session-chain-verdict'
import {
  isVerifyGateStep,
  readSessionVerdictChecks
} from '../../shared/session-chain-verdict-checks'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainVerdictReceipt
} from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeVerification } from './session-outcome-evidence'
import {
  sessionOutcomeCandidatePaths,
  sessionOutcomeCandidateVersion
} from './session-outcome-candidate'

const NO_STEP = 'An execution-owned reviewer step is required for report evidence.'
const NO_RECEIPT = 'The requested review report has no completed host execution receipt.'
const STALE = 'The review report describes an older candidate version.'
const LINE_NOT_PASSED = 'The verifier did not pass this Done When line.'
const NO_LINE_CHECKS =
  'This verify verdict has no per-line checks. Run Verify again so each Done When line is checked.'

/**
 * Why a status refusal exists at all: a `report` condition used to be met by any reviewer receipt
 * that had not crashed — including one whose verdict was `findings`. "It was reviewed" is not "it
 * is done", so only a pass is proof, and the other three say why in the person's own terms.
 */
function statusRefusal(status: SessionVerdictStatus | 'crashed'): string | null {
  if (status === 'pass') {
    return null
  }
  if (status === 'insufficient_evidence') {
    return 'The verifier could not judge this report; supply the evidence it named and verify again.'
  }
  return status === 'crashed'
    ? NO_RECEIPT
    : 'The report names blocking findings, so it is not proof that this is done.'
}

/** The receipt id of a consumed verdict, derived so the gate that minted it and the verifier that
 * re-reads it every tick produce the same string for the same decision. */
export function sessionOutcomeVerdictReceiptId(
  attemptId: string,
  receipt: SessionChainVerdictReceipt
): string {
  return `report:${attemptId}:${createHash('sha256')
    .update(
      JSON.stringify([
        receipt.stepId,
        receipt.attemptId,
        receipt.consumptionKey,
        receipt.consumedAt,
        receipt.verdict
      ])
    )
    .digest('hex')}`
}

/**
 * A verdict seat proves a report when it spent a `pass` receipt on the version in front of us. A
 * verify gate proves only a line it checked and passed: a line it was not asked about, or a gate
 * receipt without valid per-line checks (one issued before they existed), proves nothing, so the
 * gate is run again. Review and judge receipts keep proving the report on their single status.
 */
function verifyVerdictReport(
  step: SessionChainAgentStep,
  chain: SessionChain,
  version: string,
  conditionId: string
): SessionOutcomeVerification {
  const receipt = lastSessionVerdictReceipt(chain, step.id)
  const read = sessionVerdictOfReceipt(receipt)
  const attempt = chain.outcomeSet!.attempts.findLast(
    (entry) => entry.id === receipt?.attemptId && entry.state === 'completed'
  )
  if (!receipt || !read || !attempt || !chain.outcomeSet!.completedSteps?.includes(step.id)) {
    return { verified: false, reason: NO_RECEIPT }
  }
  const refusal = statusRefusal(read.status)
  if (refusal) {
    return { verified: false, reason: refusal }
  }
  const declared = step.verdict
  if (declared?.kind === 'verify' && declared.consumed === 'gate') {
    const checks = readSessionVerdictChecks((receipt.verdict as { checks?: unknown }).checks)
    if (!checks) {
      return { verified: false, reason: NO_LINE_CHECKS }
    }
    if (checks.find((check) => check.id === conditionId)?.status !== 'pass') {
      return { verified: false, reason: LINE_NOT_PASSED }
    }
  }
  return read.candidateVersion && read.candidateVersion !== version
    ? { verified: false, reason: STALE }
    : { verified: true, version, receipt: sessionOutcomeVerdictReceiptId(attempt.id, receipt) }
}

function verifyReviewReport(
  step: SessionChainAgentStep,
  chain: SessionChain,
  runtime: OrcaRuntimeService,
  version: string
): SessionOutcomeVerification {
  const assignment = step.review!
  const group = chain.reviewLoop?.groups.find((entry) => entry.id === assignment.groupId)
  const receipt = group?.rounds
    .flatMap((round) => round.receipts)
    .findLast((entry) => entry.reviewerId === assignment.reviewerId)
  const reviewed = chain.steps.find((entry) => entry.id === receipt?.stepId) ?? step
  const attempt = chain.outcomeSet!.attempts.findLast(
    (entry) => entry.actionId === `step_${reviewed.id}` && entry.state === 'completed'
  )
  const task = attempt?.taskId ? runtime.getOrchestrationDb().getTask(attempt.taskId) : undefined
  if (
    !attempt ||
    !task?.result ||
    !receipt ||
    !chain.outcomeSet!.completedSteps?.includes(reviewed.id)
  ) {
    return { verified: false, reason: NO_RECEIPT }
  }
  const refusal = statusRefusal(receipt.status)
  if (refusal) {
    return { verified: false, reason: refusal }
  }
  return version !== receipt.candidateVersion
    ? { verified: false, reason: STALE }
    : {
        verified: true,
        version,
        receipt: `report:${attempt.id}:${createHash('sha256')
          .update(JSON.stringify([receipt, task.result]))
          .digest('hex')}`
      }
}

export async function verifySessionOutcomeReport(
  condition: SessionOutcomeCondition,
  runtime?: OrcaRuntimeService,
  chain?: SessionChain
): Promise<SessionOutcomeVerification> {
  const step = chain?.steps.find((entry) => entry.id === condition.target)
  if (
    !chain?.outcomeSet ||
    !runtime ||
    !step ||
    step.kind === 'handoff' ||
    (!step.review && !step.verdict)
  ) {
    return { verified: false, reason: NO_STEP }
  }
  // The runtime invariant is read here too: a verdict seat that completed with no receipt makes
  // every report of this plan unproven, so it blocks instead of verifying on the seat beside it.
  const problems = verdictInvariantProblems(chain)
  if (problems.length) {
    return { verified: false, reason: problems[0]! }
  }
  const version = await sessionOutcomeCandidateVersion(
    chain.workspacePath,
    sessionOutcomeCandidatePaths(
      chain.outcomeSet.outcomes.find((outcome) => outcome.stepIds?.includes(step.id)),
      chain
    ),
    { folderPin: isVerifyGateStep(step) }
  )
  return step.review
    ? verifyReviewReport(step, chain, runtime, version)
    : verifyVerdictReport(step, chain, version, condition.id)
}
