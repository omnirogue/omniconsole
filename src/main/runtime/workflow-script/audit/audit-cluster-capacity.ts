import {
  AUDIT_MAX_CITATIONS_PER_FINDING,
  AUDIT_MAX_FINDINGS_PER_CLUSTER,
  type AuditFinding
} from '../../../../shared/workflow-audit-contracts'

export class AuditClusterCapacityError extends Error {
  constructor(pairCount: number, maxFindings: number) {
    super(
      `Audit cluster cannot preserve ${pairCount} unique citation pairs; output capacity is ${maxFindings * AUDIT_MAX_CITATIONS_PER_FINDING}`
    )
    this.name = 'AuditClusterCapacityError'
  }
}

export function assertAuditClusterInputCapacity(
  findings: readonly AuditFinding[],
  maxFindings: number
): void {
  const pairs = new Set(
    findings.flatMap((finding) =>
      finding.evidence.map((citation) => JSON.stringify([citation.sourceId, citation.quote]))
    )
  )
  const capacity = maxFindings * AUDIT_MAX_CITATIONS_PER_FINDING
  if (pairs.size > capacity) {
    throw new AuditClusterCapacityError(pairs.size, maxFindings)
  }
}

export function assertAuditIntermediateClusterInputCapacity(findings: readonly AuditFinding[]) {
  assertAuditClusterInputCapacity(findings, AUDIT_MAX_FINDINGS_PER_CLUSTER)
}
