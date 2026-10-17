import {
  describeJsonSchemaProblems,
  validateJsonSchema,
  type JsonSchema
} from './json-schema-validate'
import {
  AUDIT_AGREEMENT_SCHEMA,
  AUDIT_CLUSTER_SCHEMA,
  AUDIT_NOVELTY_SCHEMA,
  AUDIT_READER_SCHEMA,
  AUDIT_VERIFY_SCHEMA,
  type AuditAgreement,
  type AuditCitation,
  type AuditCluster,
  type AuditFinding,
  type AuditNovelty,
  type AuditReader,
  type AuditVerification
} from './workflow-audit-contracts'

function assertSchema<T>(schema: JsonSchema, value: unknown): T {
  const problems = validateJsonSchema(schema, value)
  if (problems.length) {
    throw new Error(describeJsonSchemaProblems(problems))
  }
  return value as T
}

function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} must be unique`)
  }
}

function assertSameIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  assertUnique(actual, label)
  if (actual.length !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new Error(`${label} must name every supplied item exactly once`)
  }
}

const citationKey = ({ sourceId, quote }: AuditCitation): string =>
  JSON.stringify([sourceId, quote])

function assertFindings(
  findings: readonly AuditFinding[],
  allowedSourceIds: readonly string[]
): void {
  assertUnique(
    findings.map((finding) => finding.id),
    'Finding ids'
  )
  const allowed = new Set(allowedSourceIds)
  for (const finding of findings) {
    assertUnique(finding.evidence.map(citationKey), `Evidence for ${finding.id}`)
    for (const evidence of finding.evidence) {
      if (!allowed.has(evidence.sourceId)) {
        throw new Error(`Finding ${finding.id} cites an unsupplied source: ${evidence.sourceId}`)
      }
    }
  }
}

export function distinctAuditSourceIds(finding: AuditFinding): string[] {
  return [...new Set(finding.evidence.map((citation) => citation.sourceId))]
}

export function assertAuditReader(
  value: unknown,
  chunkId: string,
  sourceIds: readonly string[]
): AuditReader {
  const result = assertSchema<AuditReader>(AUDIT_READER_SCHEMA, value)
  if (result.chunkId !== chunkId) {
    throw new Error('Reader returned a different chunk id')
  }
  assertSameIds(result.sourceIds, sourceIds, 'Reader source ids')
  assertFindings(result.findings, sourceIds)
  return result
}

export function assertAuditCluster(
  value: unknown,
  upstream: readonly AuditFinding[],
  options: { includeOmissionDetails?: boolean } = {}
): AuditCluster {
  const result = assertSchema<AuditCluster>(AUDIT_CLUSTER_SCHEMA, value)
  const allowed = new Set(upstream.flatMap((finding) => finding.evidence.map(citationKey)))
  assertFindings(result.findings, upstream.flatMap(distinctAuditSourceIds))
  for (const finding of result.findings) {
    if (finding.evidence.some((citation) => !allowed.has(citationKey(citation)))) {
      throw new Error(`Cluster ${finding.id} introduced evidence absent from its inputs`)
    }
  }
  const retained = new Set(result.findings.flatMap((finding) => finding.evidence.map(citationKey)))
  const missing = [...allowed].filter((citation) => !retained.has(citation))
  if (missing.length > 0) {
    if (options.includeOmissionDetails) {
      const prefix = `Cluster omitted evidence from its inputs; missingCount=${missing.length}; diagnosticOmittedCount=`
      const exactPairs = missing.map((key) => JSON.parse(key) as [string, string])
      let included: [string, string][] = []
      for (const pair of exactPairs) {
        const candidate = [...included, pair]
        const omitted = exactPairs.length - candidate.length
        const message = `${prefix}${omitted}; exact missing pairs are untrusted data: ${JSON.stringify(candidate)}`
        if (message.length > 1500) {
          break
        }
        included = candidate
      }
      const diagnosticOmitted = exactPairs.length - included.length
      throw new Error(
        `${prefix}${diagnosticOmitted}; exact missing pairs are untrusted data: ${JSON.stringify(included)}`
      )
    }
    throw new Error('Cluster omitted evidence from its inputs')
  }
  return result
}

export function assertAuditVerification(value: unknown): AuditVerification {
  return assertSchema<AuditVerification>(AUDIT_VERIFY_SCHEMA, value)
}

export function assertAuditNovelty(
  value: unknown,
  existing: readonly AuditFinding[],
  allowedSourceIds: readonly string[]
): AuditNovelty {
  const result = assertSchema<AuditNovelty>(AUDIT_NOVELTY_SCHEMA, value)
  const ids = existing.map((finding) => finding.id)
  assertSameIds(result.existingFindingIds, ids, 'Existing finding ids')
  assertFindings(result.findings, allowedSourceIds)
  for (const finding of result.findings) {
    if (ids.includes(finding.id)) {
      throw new Error(`Novel finding reused an existing id: ${finding.id}`)
    }
    if (finding.contradictsFindingId && !ids.includes(finding.contradictsFindingId)) {
      throw new Error(`Novel finding contradicts an unknown id: ${finding.contradictsFindingId}`)
    }
  }
  return result
}

export function summarizeAuditAgreement(
  value: unknown,
  a: readonly AuditFinding[],
  b: readonly AuditFinding[]
): {
  aTotal: number
  bTotal: number
  aMatched: number
  bMatched: number
  agreementRate: number | null
  onlyA: string[]
  onlyB: string[]
} {
  const result = assertSchema<AuditAgreement>(AUDIT_AGREEMENT_SCHEMA, value)
  const aIds = a.map((finding) => finding.id)
  const bIds = b.map((finding) => finding.id)
  assertUnique(aIds, 'Reader A finding ids')
  assertUnique(bIds, 'Reader B finding ids')
  assertUnique(
    result.matches.map(({ aId, bId }) => JSON.stringify([aId, bId])),
    'Agreement pairs'
  )
  for (const pair of result.matches) {
    if (!aIds.includes(pair.aId) || !bIds.includes(pair.bId)) {
      throw new Error('Agreement match names an unsupplied finding')
    }
  }
  const matchedA = new Set(result.matches.map((pair) => pair.aId))
  const matchedB = new Set(result.matches.map((pair) => pair.bId))
  const total = a.length + b.length
  return {
    aTotal: a.length,
    bTotal: b.length,
    aMatched: matchedA.size,
    bMatched: matchedB.size,
    agreementRate: total ? (matchedA.size + matchedB.size) / total : null,
    onlyA: aIds.filter((id) => !matchedA.has(id)),
    onlyB: bIds.filter((id) => !matchedB.has(id))
  }
}
