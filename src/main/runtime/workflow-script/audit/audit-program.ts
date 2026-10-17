import type { WorkflowProgramContext } from '../workflow-program-context'
import { auditCaller } from './audit-call'
import { compareAuditReaders, findAuditNovelty, readAudit } from './audit-read'
import { reviewAuditFindings } from './audit-review'
import { planAudit } from './audit-plan'
import type { AuditSnapshot } from './audit-snapshot'
import type { AuditCheckEvidence } from './audit-source-store'
import type { AuditJudgementObservation, AuditJudgementRequest } from './audit-judgements'

const AGREEMENT_DEFINITION =
  'Many-to-many pairs are allowed. Rate = (unique matched A count + unique matched B count) / (total A findings + total B findings). When both readers return zero findings, the rate is undefined (represented as null). Unequal reader counts can still yield 100%; overlap is not accuracy.'

export type AuditProgramPorts = {
  checkEvidence: AuditCheckEvidence
  observeJudgements: (request: AuditJudgementRequest) => Promise<AuditJudgementObservation>
}

/** A bundled program on the existing durable port, with no scheduler or process ownership of its own. */
export async function runAuditProgram(
  context: WorkflowProgramContext,
  audit: AuditSnapshot,
  task: string,
  ports: AuditProgramPorts
) {
  const ask = auditCaller(context, task, audit.version)
  const reading = await readAudit(context, ask, audit)
  const agreement = await compareAuditReaders(context, ask, audit, reading.readers)
  const discovery = await findAuditNovelty(
    context,
    ask,
    audit,
    reading.findings,
    agreement.flatMap((sample) => sample.additional)
  )
  const reviewed = await reviewAuditFindings(
    context,
    ask,
    audit,
    discovery.findings,
    ports.checkEvidence
  )
  context.guard()
  const grounded = reviewed.filter((finding) => finding.sourceCheck.check.allVerified)
  const observation = await ports.observeJudgements({
    callId: 'audit/theme-judgements',
    findings: grounded,
    verifiedSourceIds: [
      ...new Set(
        grounded.flatMap((finding) => finding.evidence.map((citation) => citation.sourceId))
      )
    ],
    pairs: []
  })
  context.log(`Audit JEV shadow: ${observation.reason}; generative judgments remain authoritative`)
  const judgements = [observation]
  if (grounded.length > 1) {
    judgements.push(
      await ports.observeJudgements({
        callId: 'audit/duplicate-judgements',
        findings: grounded,
        rankThemes: false,
        verifiedSourceIds: [
          ...new Set(
            grounded.flatMap((finding) => finding.evidence.map((citation) => citation.sourceId))
          )
        ],
        pairs: grounded.slice(1).map((finding, index) => ({
          kind: 'duplicate',
          aId: grounded[index].id,
          bId: finding.id
        }))
      })
    )
  }
  for (const sample of agreement) {
    context.guard()
    const a = sample.readings.a.findings.map((finding, i) => ({ ...finding, id: `a-${i}` }))
    const b = sample.readings.b.findings.map((finding, i) => ({ ...finding, id: `b-${i}` }))
    const findings = [...a, ...b]
    const packet = await ports.checkEvidence(findings.flatMap((finding) => finding.evidence))
    const pairs = a.flatMap((left) =>
      b.map((right) => ({ kind: 'agreement' as const, aId: left.id, bId: right.id }))
    )
    // Each batch has at most 32 judgments plus their availability questions.
    for (let offset = 0; offset < pairs.length; offset += 32) {
      context.guard()
      judgements.push(
        await ports.observeJudgements({
          callId: `audit/agreement-shadow/${sample.chunkId}/${offset / 32}`,
          findings,
          pairs: pairs.slice(offset, offset + 32),
          rankThemes: false,
          verifiedSourceIds: packet.check.allVerified
            ? [
                ...new Set(
                  findings.flatMap((finding) =>
                    finding.evidence.map((citation) => citation.sourceId)
                  )
                )
              ]
            : []
        })
      )
    }
  }
  const gaps = reviewed
    .filter((finding) => finding.disposition === 'unverified')
    .map((finding) => `${finding.id}: evidence or impact is unverified`)
  if (!audit.agreementSamples) {
    gaps.push('Reader agreement was not sampled')
  }
  if (!audit.noveltyLenses.length) {
    gaps.push('Novelty was not sampled; agreement-only findings remain in the method record')
  }
  if (!audit.reference?.facts || !audit.reference.requests) {
    gaps.push('No complete independent facts and requests supplied to the completeness critic')
  }
  const method = {
    sourceCount: audit.corpus.sources.length,
    sources: audit.corpus.sources,
    readersCompleted: reading.readers.length,
    readersExpected: audit.corpus.chunks.length,
    readers: reading.readers,
    agreement,
    novelty: discovery.novelty,
    reference: audit.reference,
    gaps,
    ...(audit.version >= 3 ? { agreementDefinition: AGREEMENT_DEFINITION } : {}),
    ...(audit.version >= 4
      ? {
          readerDefinition:
            'readersCompleted and readersExpected count primary per-chunk reads only. Agreement samples run a separate second reader for selected chunks; those rereads are counted in agreement, not in these reader totals.'
        }
      : {})
  }
  const plan = await planAudit(context, ask, audit, reviewed, method)
  return {
    version: audit.version,
    ...method,
    reviewed,
    judgements,
    ...plan,
    final: { markdown: plan.markdown }
  }
}
