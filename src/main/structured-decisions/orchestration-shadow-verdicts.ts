import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { OrchestrationShadowEmit, OrchestrationShadowKind } from './orchestration-shadow'
import {
  OrchestrationShadowScan,
  shadowFieldEqual,
  shadowIdentity,
  shadowReference
} from './orchestration-shadow-bounds'
import { countOrchestrationShadow as count } from './orchestration-shadow-measurement'

const VERDICTS = {
  pass: 'The supplied evidence establishes the declared requirements with no blockers.',
  findings: 'The supplied evidence establishes actionable blocking findings.',
  fail: 'The supplied evidence establishes that a required condition failed.',
  insufficient_evidence: 'The structural facts cannot establish a substantive verdict.',
  crashed: 'The reviewer stopped without producing a verdict.'
}

function verdictKind(step: SessionChainAgentStep): OrchestrationShadowKind {
  if (step.review?.adversarial || step.verdict?.kind === 'critique') {
    return 'adversarial_review'
  }
  if (step.verdict?.kind === 'judge') {
    return 'judge'
  }
  if (step.verdict?.kind === 'verify') {
    return 'verify'
  }
  return 'review'
}

function emitVerdict(
  chain: SessionChain,
  stepId: string,
  reference: string,
  raw: unknown,
  emit: OrchestrationShadowEmit,
  scan: OrchestrationShadowScan
): void {
  const step = scan.tail(chain.steps).values.find((entry) => shadowFieldEqual(entry.id, stepId))
  if (!step || step.kind === 'handoff' || !raw || typeof raw !== 'object') {
    return
  }
  const verdict = raw as Record<string, unknown>
  if (!shadowIdentity(verdict.status) || !Object.hasOwn(VERDICTS, verdict.status)) {
    return
  }
  emit({
    kind: verdictKind(step),
    reference: shadowReference(chain.id, reference),
    observed: verdict.status,
    choices: VERDICTS,
    facts: {
      planVersion: chain.planVersion ?? 1,
      candidateCount: step.verdict?.over.length ?? 0,
      blockingFindingCount: Array.isArray(verdict.blockingFindings)
        ? verdict.blockingFindings.length
        : null,
      scoreCount: Array.isArray(verdict.scores) ? verdict.scores.length : 0,
      winnerDeclared: typeof verdict.winnerId === 'string',
      candidateVersionPinned: Boolean(step.review?.candidateVersion),
      candidateVersionMatches:
        shadowIdentity(step.review?.candidateVersion) && shadowIdentity(verdict.candidateVersion)
          ? step.review.candidateVersion === verdict.candidateVersion
          : null,
      substantiveEvidenceIncluded: false
    }
  })
}

export function observeVerdictShadowChanges(
  previous: SessionChain,
  saved: SessionChain,
  emit: OrchestrationShadowEmit,
  scan = new OrchestrationShadowScan()
): void {
  const priorSample = scan.tail(previous.verdicts)
  const prior = new Set(
    priorSample.values.map((receipt) => receipt.consumptionKey).filter(shadowIdentity)
  )
  const current = scan.tail(saved.verdicts)
  const emittedSteps = new Set<string>()
  for (const [index, receipt] of current.values.entries()) {
    if (
      receipt.skipped ||
      !shadowIdentity(receipt.consumptionKey) ||
      !shadowIdentity(receipt.stepId)
    ) {
      continue
    }
    if (prior.has(receipt.consumptionKey)) {
      continue
    }
    if (!priorSample.complete && current.start + index < priorSample.total) {
      count('ambiguousBaselineSkipped')
      continue
    }
    emittedSteps.add(receipt.stepId)
    emitVerdict(saved, receipt.stepId, receipt.consumptionKey, receipt.verdict, emit, scan)
  }
  const oldGroups = scan.tail(previous.reviewLoop?.groups, 4)
  for (const group of scan.tail(saved.reviewLoop?.groups, 4).values) {
    if (!shadowIdentity(group.id)) {
      continue
    }
    const old = oldGroups.values.find((entry) => shadowFieldEqual(entry.id, group.id))
    if (!old && !oldGroups.complete) {
      count('ambiguousBaselineSkipped')
      continue
    }
    const oldRounds = scan.tail(old?.rounds, 2)
    for (const round of scan.tail(group.rounds, 2).values) {
      const oldRound = oldRounds.values.find((entry) => entry.index === round.index)
      if (!oldRound && !oldRounds.complete) {
        count('ambiguousBaselineSkipped')
        continue
      }
      const receipts = scan.tail(oldRound?.receipts, 8)
      for (const receipt of scan.tail(round.receipts, 8).values) {
        if (!receipts.complete) {
          count('ambiguousBaselineSkipped')
          continue
        }
        if (
          !shadowIdentity(receipt.stepId) ||
          emittedSteps.has(receipt.stepId) ||
          receipts.values.some(
            (entry) =>
              shadowFieldEqual(entry.stepId, receipt.stepId) &&
              entry.recordedAt === receipt.recordedAt
          )
        ) {
          continue
        }
        emitVerdict(
          saved,
          receipt.stepId,
          shadowReference(group.id, round.index, receipt.stepId, receipt.recordedAt),
          receipt,
          emit,
          scan
        )
      }
    }
  }
}
