import type { WorkflowProgramContext } from '../../../../src/main/runtime/workflow-script/workflow-program-context'
import type { WorkflowProgramSnapshot } from '../../../../src/main/runtime/workflow-script/workflow-program-snapshot'
import {
  auditCaller,
  requireAuditResults
} from '../../../../src/main/runtime/workflow-script/audit/audit-call'
import {
  runAuditProgram,
  type AuditProgramPorts
} from '../../../../src/main/runtime/workflow-script/audit/audit-program'
import {
  AUDIT_CLUSTER_SCHEMA,
  AUDIT_READER_SCHEMA,
  type AuditFinding,
  type AuditReader
} from '../../../../src/shared/workflow-audit-contracts'
import {
  assertAuditCluster,
  assertAuditReader
} from '../../../../src/shared/workflow-audit-validation'

export const AUDIT_QUALITY_ARMS = ['direct', 'reader-merge', 'full'] as const
export type AuditQualityArm = (typeof AUDIT_QUALITY_ARMS)[number]
export type AuditQualityAnswer = { findings: AuditFinding[]; markdown: string; raw: unknown }
const baselineReport =
  'Write a complete Markdown audit report: scope and source coverage; supported themes with distinct-source counts and short quotes; ranked initiatives with finding IDs, owner, effort, honest expected gain, metric and first step; sequence; metrics; rejected or uncertain claims; method; limitations; open questions. Unknown status stays unknown. Shipped work calls for adoption rather than rebuilding. Do not invent savings, judge ballots, agreement or novelty measurements.'
const reportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['markdown'],
  properties: { markdown: { type: 'string', minLength: 1 } }
}

/** All routes use the caller's existing durable agent port and identical frozen evidence. */
export async function runAuditQualityArm(
  context: WorkflowProgramContext,
  snapshot: WorkflowProgramSnapshot,
  arm: AuditQualityArm,
  ports: AuditProgramPorts
): Promise<AuditQualityAnswer> {
  const audit = snapshot.audit!
  if (arm === 'full') {
    const result = await runAuditProgram(context, audit, snapshot.task.prompt, ports)
    const findings = result.reviewed
      .filter((finding) => finding.disposition === 'survived')
      .map(({ id, title, description, evidence, impact, proposedFix }) => ({
        id,
        title,
        description,
        evidence,
        impact,
        proposedFix
      }))
    return { findings, markdown: result.markdown, raw: result }
  }
  const ask = auditCaller(context, snapshot.task.prompt)
  if (arm === 'direct') {
    const schema = {
      ...AUDIT_CLUSTER_SCHEMA,
      required: [...AUDIT_CLUSTER_SCHEMA.required!, 'markdown'],
      properties: { ...AUDIT_CLUSTER_SCHEMA.properties, markdown: reportSchema.properties.markdown }
    }
    const result = await ask(
      'quality/direct',
      [
        'Independently audit ALL sources and reference material. Examine requests, repeated friction, wins, omissions and counterevidence before deciding what matters.',
        'Check your proposed claims against the supplied original text. Distinguish speakers, automation, clipping, unknown status, and distinct sources. Preserve contradictions and reject unsupported claims. Return findings with exact source IDs and quotes, plus the complete report.',
        'For this direct response there is no plan panel: choose your own strongest supported recommendations and state uncertain tradeoffs.',
        baselineReport
      ].join('\n'),
      audit.readerSeatId,
      { corpus: audit.corpus, reference: audit.reference, existing: audit.existingFindings },
      schema,
      (value) => {
        const result = value as { findings: AuditFinding[]; markdown: string }
        assertAuditReader(
          {
            version: 1,
            chunkId: 'all',
            sourceIds: audit.corpus.sources.map((source) => source.id),
            findings: result.findings
          },
          'all',
          audit.corpus.sources.map((source) => source.id)
        )
        return result
      }
    )
    return { findings: result.findings, markdown: result.markdown, raw: result }
  }
  const readers = requireAuditResults(
    await context.parallel(
      audit.corpus.chunks.map(
        (chunk) => () =>
          ask(
            `read/${chunk.id}`,
            'Audit every source in the chunk independently. Extract requests, friction, wins and unfinished work; retain counterevidence. Give exact quotes and source IDs. Distinguish human, automation, clipping and unknowns.',
            audit.readerSeatId,
            { chunk, reference: audit.reference, existing: audit.existingFindings },
            AUDIT_READER_SCHEMA,
            (value) => assertAuditReader(value, chunk.id, chunk.sourceIds)
          )
      )
    ),
    'baseline readers'
  ) as AuditReader[]
  const findings = [...audit.existingFindings, ...readers.flatMap((reader) => reader.findings)]
  const merged = await ask(
    'merge',
    'Merge duplicate findings while preserving every supplied citation pair and contradictory evidence. Count distinct sources; never sum model counts. Return concrete findings.',
    audit.reviewerSeatId,
    { findings },
    AUDIT_CLUSTER_SCHEMA,
    (value) => assertAuditCluster(value, findings)
  )
  const report = await ask(
    'quality/report',
    baselineReport,
    audit.synthesizerSeatId,
    { corpus: audit.corpus, reference: audit.reference, findings: merged.findings },
    reportSchema,
    (value) => value as { markdown: string }
  )
  return { findings: merged.findings, markdown: report.markdown, raw: { readers, merged, report } }
}
