import {
  AUDIT_AGREEMENT_SCHEMA,
  AUDIT_CLUSTER_SCHEMA,
  AUDIT_NOVELTY_SCHEMA,
  AUDIT_READER_SCHEMA,
  type AuditAgreement,
  type AuditFinding,
  type AuditReader
} from '../../../../shared/workflow-audit-contracts'
import {
  assertAuditCluster,
  assertAuditNovelty,
  assertAuditReader,
  summarizeAuditAgreement
} from '../../../../shared/workflow-audit-validation'
import type { WorkflowProgramContext } from '../workflow-program-context'
import { requireAuditResults, type AuditAsk } from './audit-call'
import type { AuditSnapshot } from './audit-snapshot'
import { EARLIER_RUNS_LABEL } from '../workflow-earlier-findings'
import {
  assertAuditClusterInputCapacity,
  assertAuditIntermediateClusterInputCapacity,
  AuditClusterCapacityError
} from './audit-cluster-capacity'

const READER =
  'Read every source in this chunk, in full. Return every source ID even when it yields no finding. Extract requests, friction, wins and unfinished work with exact quotes (at most 300 characters). Distinguish human from automation and clipped material. Use short finding IDs unique in this response. Do not infer occurrences from repeated quotations.'
const CLUSTER =
  'Cluster related findings into themes. Merge evidence by distinct source IDs, preserving every supplied citation pair exactly; never invent a quote or sum model counts. Keep opposing claims distinguishable. Return unique theme IDs. Explain the proposed change concretely.'
const CLUSTER_REVISION_4 =
  'Cluster related findings into themes. Preserve every supplied exact (sourceId, full quote) citation pair at least once. ' +
  'Deduplicate only identical pairs of source ID and full quote; source counts are computed separately by distinct source ID. ' +
  'Quotes from one source that overlap or where one is a substring of another are distinct and both must remain. ' +
  'Never replace, normalize, shorten, combine or invent quote text, or sum model counts. Keep opposing claims distinguishable. Return unique theme IDs. Explain the proposed change concretely.'

function clusterInstruction(version: AuditSnapshot['version']): string {
  return version >= 4 ? CLUSTER_REVISION_4 : CLUSTER
}

function assertClusterForRevision(
  value: unknown,
  findings: AuditFinding[],
  version: AuditSnapshot['version']
) {
  return assertAuditCluster(value, findings, { includeOmissionDetails: version >= 4 })
}

export function auditSampleIndexes(size: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.floor((i * size) / count))
}

export async function readAudit(
  context: WorkflowProgramContext,
  ask: AuditAsk,
  audit: AuditSnapshot
) {
  context.phase('Read and cluster')
  const readers: AuditReader[] = []
  const count = Math.min(audit.clusterGroups, audit.corpus.chunks.length)
  const groups = Array.from({ length: count }, (_, index) =>
    audit.corpus.chunks.filter((_, i) => i % count === index)
  )
  const capacityFailures = new Map<number, AuditClusterCapacityError>()
  const clusterResults = await context.pipeline(
    groups,
    async (chunks: (typeof groups)[number], _group: unknown, index: number) => {
      const results = requireAuditResults(
        await context.parallel(
          chunks.map(
            (chunk) => () =>
              ask(
                `read/${chunk.id}`,
                READER,
                audit.readerSeatId,
                { chunk },
                AUDIT_READER_SCHEMA,
                (value) => assertAuditReader(value, chunk.id, chunk.sourceIds)
              )
          )
        ),
        'readers'
      ) as AuditReader[]
      readers.push(...results)
      const findings = results.flatMap((reader) => reader.findings)
      if (audit.version !== 1) {
        try {
          assertAuditIntermediateClusterInputCapacity(findings)
        } catch (error) {
          if (error instanceof AuditClusterCapacityError) {
            capacityFailures.set(index, error)
          }
          throw error
        }
      }
      return ask(
        `cluster/${index}`,
        clusterInstruction(audit.version),
        audit.reviewerSeatId,
        { findings },
        AUDIT_CLUSTER_SCHEMA,
        (value) => assertClusterForRevision(value, findings, audit.version),
        chunks.map((chunk) => `read/${chunk.id}`)
      )
    }
  )
  const earliestCapacityFailure = [...capacityFailures.entries()].sort(([a], [b]) => a - b)[0]
  if (earliestCapacityFailure) {
    throw earliestCapacityFailure[1]
  }
  const clustered = requireAuditResults(clusterResults, 'clusters') as {
    findings: AuditFinding[]
  }[]
  // Settlement order must never change a prompt or a durable call's identity.
  readers.sort(
    (a, b) =>
      audit.corpus.chunks.findIndex((c) => c.id === a.chunkId) -
      audit.corpus.chunks.findIndex((c) => c.id === b.chunkId)
  )
  const inputs = [...audit.existingFindings, ...clustered.flatMap((cluster) => cluster.findings)]
  if (audit.version !== 1) {
    assertAuditClusterInputCapacity(inputs, audit.maxThemes)
  }
  const merged = await ask(
    'merge',
    `${clusterInstruction(audit.version)} Return at most ${audit.maxThemes} themes.`,
    audit.reviewerSeatId,
    { findings: inputs },
    AUDIT_CLUSTER_SCHEMA,
    (value) => boundedCluster(value, inputs, audit.maxThemes, audit.version),
    groups.map((_, i) => `cluster/${i}`)
  )
  return { readers, findings: merged.findings }
}

function boundedCluster(
  value: unknown,
  inputs: AuditFinding[],
  max: number,
  version: AuditSnapshot['version']
) {
  const result = assertClusterForRevision(value, inputs, version)
  if (result.findings.length > max) {
    throw new Error(`Return at most ${max} themes`)
  }
  return result
}

export async function compareAuditReaders(
  context: WorkflowProgramContext,
  ask: AuditAsk,
  audit: AuditSnapshot,
  readers: AuditReader[]
) {
  context.phase('Agreement sample')
  return requireAuditResults(
    await context.parallel(
      auditSampleIndexes(readers.length, audit.agreementSamples).map((index) => async () => {
        const a = readers[index]
        const chunk = audit.corpus.chunks[index]
        const b = await ask(
          `reread/${chunk.id}`,
          `Independently describe where effort was lost, what people wanted, what worked and what remained unfinished. ${READER}`,
          audit.reviewerSeatId,
          { chunk },
          AUDIT_READER_SCHEMA,
          (value) => assertAuditReader(value, chunk.id, chunk.sourceIds)
        )
        const match = await ask(
          `agreement/${chunk.id}`,
          'Match findings that describe the same underlying issue, not merely similar wording. Return explicit finding ID pairs and reasons. Do not count matches; code does that.',
          audit.judgeSeatIds[0],
          { a, b },
          AUDIT_AGREEMENT_SCHEMA,
          (value) => {
            summarizeAuditAgreement(value, a.findings, b.findings)
            return value as AuditAgreement
          },
          [`read/${chunk.id}`, `reread/${chunk.id}`]
        )
        const summary = summarizeAuditAgreement(match, a.findings, b.findings)
        return {
          chunkId: chunk.id,
          ...summary,
          readings: { a, b },
          additional: b.findings.filter((finding) => summary.onlyB.includes(finding.id))
        }
      })
    ),
    'agreement'
  ) as {
    chunkId: string
    aTotal: number
    bTotal: number
    aMatched: number
    bMatched: number
    agreementRate: number | null
    onlyA: string[]
    onlyB: string[]
    additional: AuditFinding[]
    readings: { a: AuditReader; b: AuditReader }
  }[]
}

export async function findAuditNovelty(
  context: WorkflowProgramContext,
  ask: AuditAsk,
  audit: AuditSnapshot,
  existing: AuditFinding[],
  additional: AuditFinding[]
) {
  if (!audit.noveltyLenses.length) {
    return { findings: existing, novelty: [] }
  }
  context.phase('Novelty')
  const pairs = Array.from({ length: Math.ceil(audit.corpus.chunks.length / 2) }, (_, i) =>
    audit.corpus.chunks.slice(i * 2, i * 2 + 2)
  )
  const novelty = requireAuditResults(
    await context.parallel(
      pairs.map((chunks, i) => () => {
        const lens = audit.noveltyLenses[i % audit.noveltyLenses.length]
        // Only a run admitted with a list asks differently; every other prompt stays as it was.
        const earlier = audit.earlierFindings?.titles.length ? audit.earlierFindings.titles : null
        return ask(
          `novelty/${i}`,
          `Read all supplied sources through the named lens. Find only what the existing finding list misses, or evidence contradicting it. Explain why each is not covered. Return an empty list when nothing new is supported.${earlier ? ` ${EARLIER_RUNS_LABEL}: the titles in earlierRuns.` : ''}`,
          audit.readerSeatId,
          earlier ? { lens, chunks, existing, earlierRuns: earlier } : { lens, chunks, existing },
          AUDIT_NOVELTY_SCHEMA,
          (value) => {
            const result = assertAuditNovelty(
              value,
              existing,
              chunks.flatMap((chunk) => chunk.sourceIds)
            )
            if (result.lens !== lens) {
              throw new Error('Return the assigned novelty lens')
            }
            return result
          },
          ['merge']
        )
      })
    ),
    'novelty'
  ) as { findings: AuditFinding[] }[]
  const findings = [...existing, ...additional, ...novelty.flatMap((value) => value.findings)]
  if (audit.version !== 1) {
    assertAuditClusterInputCapacity(findings, audit.maxThemes)
  }
  const merged = await ask(
    'novelty-merge',
    `${clusterInstruction(audit.version)} Compare candidates against the existing list and each other. Preserve contradictions. Return at most ${audit.maxThemes} themes.`,
    audit.reviewerSeatId,
    { existing, additional, novelty },
    AUDIT_CLUSTER_SCHEMA,
    (value) => boundedCluster(value, findings, audit.maxThemes, audit.version),
    ['merge', ...pairs.map((_, i) => `novelty/${i}`)]
  )
  return { findings: merged.findings, novelty }
}
