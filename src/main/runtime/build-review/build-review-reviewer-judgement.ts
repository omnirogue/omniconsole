import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkerSnapshot
} from '../../../shared/build-review-pipeline'
import {
  describeCheckedFinding,
  parseReviewFindings,
  reviewFindingBlocks,
  type CheckedReviewFinding
} from '../../../shared/review-findings'
import {
  checkReviewFinding,
  checkReviewFindings,
  type ReviewEvidenceHost
} from './build-review-evidence'

export type ReviewerJudgement = {
  /** Whether this reviewer withholds approval. */
  blocks: boolean
  /** Why the host read the reviewer differently from its verdict line, when it did. */
  note?: string
}

/**
 * One reviewer, judged. With evidence required, a blocker withholds approval unless a complete
 * check cleared it; without a readable findings line the verdict decides, as before, so a
 * malformed line can never turn a rejection into an approval.
 */
export async function judgeReviewer(
  pipeline: BuildReviewPipelineSnapshot,
  reviewer: BuildReviewWorkerSnapshot,
  verdict: 'APPROVE' | 'REQUEST_CHANGES',
  host: ReviewEvidenceHost
): Promise<ReviewerJudgement> {
  if (!pipeline.evidenceRequired) {
    return { blocks: verdict === 'REQUEST_CHANGES' }
  }
  const findings = parseReviewFindings(reviewer.report?.body)
  if (!findings) {
    reviewer.findings = null
    return {
      blocks: verdict === 'REQUEST_CHANGES',
      note: 'no readable findings line, so its verdict decides'
    }
  }
  const checked = await checkReviewFindings(findings, host)
  reviewer.findings = checked
  const blocks = checked.some(reviewFindingBlocks)
  if (verdict === 'REQUEST_CHANGES' && !blocks) {
    return {
      blocks,
      note: 'it requested changes, but no blocker held up on the candidate; its findings go forward as suggestions'
    }
  }
  if (verdict === 'APPROVE' && blocks) {
    return {
      blocks,
      note: 'it approved, but a blocker it reported still blocks; approval is withheld'
    }
  }
  return { blocks }
}

/** The host's check of a reviewer's findings, as the builder and the next round read it. */
export function describeReviewerFindings(findings: readonly CheckedReviewFinding[]): string {
  return findings.length
    ? ['Host check of the findings:', ...findings.map(describeCheckedFinding)].join('\n')
    : 'Host check of the findings: none reported.'
}

/**
 * What this seat reported last round, with every blocker checked again on the revised candidate:
 * a repro that now passes is the host's evidence the fix landed.
 */
export async function previousFindingsForSeat(
  previous: BuildReviewWorkerSnapshot | undefined,
  host: ReviewEvidenceHost
): Promise<string | null> {
  const findings = previous?.findings
  if (!findings?.length) {
    return null
  }
  const lines: string[] = []
  for (const finding of findings) {
    if (finding.severity !== 'blocker' || finding.status !== 'confirmed') {
      lines.push(describeCheckedFinding(finding))
      continue
    }
    const again = await checkReviewFinding(finding, host)
    lines.push(
      `${describeCheckedFinding(finding)}\n  After this round's build: ${
        again.status === 'confirmed'
          ? `still reproduces (${again.detail ?? 'unchanged'})`
          : again.status === 'located'
            ? `evidence located but not proven; still blocking (${again.detail ?? 'unresolved'})`
            : `could not be re-checked (${again.detail ?? 'unknown'})`
      }`
    )
  }
  return [
    'Your findings from the previous round, as the host checked them. Confirm each is fixed, still stands (with evidence), or withdraw it:',
    ...lines
  ].join('\n')
}
