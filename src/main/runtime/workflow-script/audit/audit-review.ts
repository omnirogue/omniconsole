import {
  AUDIT_VERIFY_SCHEMA,
  type AuditFinding,
  type AuditVerification
} from '../../../../shared/workflow-audit-contracts'
import { assertAuditVerification } from '../../../../shared/workflow-audit-validation'
import type { WorkflowProgramContext } from '../workflow-program-context'
import { requireAuditResults, type AuditAsk } from './audit-call'
import type { AuditSnapshot } from './audit-snapshot'
import type { AuditCheckEvidence, AuditEvidencePacket } from './audit-source-store'

export type AuditReviewedFinding = AuditFinding & {
  evidenceCount: number
  adjustedImpact: number
  status: NonNullable<AuditVerification['status']>
  disposition: 'survived' | 'dropped' | 'unverified'
  verification: {
    evidence: AuditVerification
    impact: AuditVerification
    status: AuditVerification
  }
  sourceCheck: AuditEvidencePacket
}

export function auditSurvival(
  check: AuditEvidencePacket,
  evidence: AuditVerification,
  impact: AuditVerification
): AuditReviewedFinding['disposition'] {
  if (
    check.check.citations.some((citation) =>
      ['quote-not-found', 'source-not-registered', 'invalid-quote'].includes(citation.status)
    ) ||
    evidence.verdict === 'refuted' ||
    impact.verdict === 'refuted'
  ) {
    return 'dropped'
  }
  if (!check.check.allVerified || evidence.verdict === 'unknown' || impact.verdict === 'unknown') {
    return 'unverified'
  }
  return 'survived'
}

export async function reviewAuditFindings(
  context: WorkflowProgramContext,
  ask: AuditAsk,
  audit: AuditSnapshot,
  findings: AuditFinding[],
  checkEvidence: AuditCheckEvidence
) {
  context.phase('Verify evidence, impact and status')
  return requireAuditResults(
    await context.parallel(
      findings.map((finding, index) => async () => {
        context.guard()
        const sourceCheck = await checkEvidence(finding.evidence)
        context.guard()
        const lenses = {
          evidence:
            'Adversarially check whether the re-read source excerpts support this claim and frequency. Exact quote presence alone is not proof of the claim. Refute misattributed or fabricated evidence. Missing, changed or unreadable material is unknown.',
          impact:
            'Assess whether fixing this issue materially improves finished work, based only on supplied evidence. Return adjustedImpact 1–5. Refute only if no material benefit is supported; missing evidence is unknown.',
          status:
            'Check whether the supplied evidence establishes this issue is solved, planned or unaddressed. Without current independent status evidence, return status unknown. Do not infer unaddressed from a failed or absent search. Shipped work may need adoption; status never drops a theme.'
        } as const
        const keys = Object.keys(lenses) as (keyof typeof lenses)[]
        const values = requireAuditResults(
          await context.parallel(
            keys.map(
              (lens) => () =>
                ask(
                  `verify/${index}/${lens}`,
                  lenses[lens],
                  audit.reviewerSeatId,
                  { finding, sourceCheck, reference: audit.reference },
                  AUDIT_VERIFY_SCHEMA,
                  (value) => {
                    const result = assertAuditVerification(value)
                    if (
                      lens === 'impact' &&
                      result.verdict !== 'unknown' &&
                      result.adjustedImpact === undefined
                    ) {
                      throw new Error('Impact lens must supply adjustedImpact')
                    }
                    if (lens === 'status' && result.status === undefined) {
                      throw new Error('Status lens must supply status, including unknown')
                    }
                    return result
                  },
                  [audit.noveltyLenses.length ? 'novelty-merge' : 'merge']
                )
            )
          ),
          `verification for ${finding.id}`
        ) as AuditVerification[]
        const [evidence, impact, status] = values
        return {
          ...finding,
          evidenceCount: sourceCheck.check.verifiedSourceCount,
          adjustedImpact: impact.adjustedImpact ?? finding.impact,
          status: status.status ?? 'unknown',
          disposition: auditSurvival(sourceCheck, evidence, impact),
          verification: { evidence, impact, status },
          sourceCheck
        } satisfies AuditReviewedFinding
      })
    ),
    'verification'
  ) as AuditReviewedFinding[]
}
