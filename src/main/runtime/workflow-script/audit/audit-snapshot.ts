import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { buildAuditCorpus, type AuditCorpus, type AuditSource } from './audit-corpus'
import { parseAuditDigestJsonl } from './audit-digest'
import type { AuditFinding } from '../../../../shared/workflow-audit-contracts'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import { mayIssueVerdict } from '../../../../shared/model-lineage'
import { assertAuditCluster } from '../../../../shared/workflow-audit-validation'
import { workflowEvidenceDigest } from '../workflow-evidence-digest'
import { readNodeFileSyncWithinLimit } from '../../../../shared/node-bounded-file-reader'
import { isSupportedAuditRevision, type AuditProgramRevision } from './audit-program-revision'
import { EARLIER_TITLE_MAX_CHARS, EARLIER_TITLES_MAX } from '../workflow-earlier-findings'

export { AUDIT_PROGRAM_REVISION } from './audit-program-revision'
export const AUDIT_MAX_CALLS = 200
const MAX_CORPUS_BYTES = 32 * 1024 * 1024

export type AuditSnapshot = {
  version: AuditProgramRevision
  sourceFile: string
  format: 'sources-jsonl' | 'digests-jsonl'
  corpus: AuditCorpus
  readerSeatId: string
  reviewerSeatId: string
  plannerSeatIds: string[]
  judgeSeatIds: string[]
  synthesizerSeatId: string
  clusterGroups: number
  agreementSamples: number
  noveltyLenses: string[]
  maxThemes: number
  existingFindings: AuditFinding[]
  /** Independently collected facts, requests and current status, treated as reference data. */
  reference?: { facts: string; requests: string; status: string }
  /**
   * Earlier runs' theme titles on this corpus (workflow-earlier-findings.ts), shown to the novelty
   * readers only; they cite no source, so they never join existingFindings.
   */
  earlierFindings?: { runs: string[]; titles: string[] }
}

/** The path belongs to this execution host and comes from the caller, never a model result. */
export function readAuditSources(file: string, format: AuditSnapshot['format']): AuditSource[] {
  if (!isAbsolute(file)) {
    throw new Error('Audit corpus needs an absolute execution-host path')
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
  let text: string
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('Audit corpus must be a regular file at most 32 MiB')
    }
    text = readNodeFileSyncWithinLimit(descriptor, MAX_CORPUS_BYTES).buffer.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
  if (format === 'digests-jsonl') {
    return parseAuditDigestJsonl(text)
  }
  if (format !== 'sources-jsonl') {
    throw new Error('Unsupported audit corpus format')
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditSource)
}

export function captureAuditCorpus(
  file: string,
  format: AuditSnapshot['format'],
  maxChunkBytes = 230_000
) {
  if (!isAbsolute(file)) {
    throw new Error('Audit corpus needs an absolute execution-host path')
  }
  const sourceFile = realpathSync(file)
  return {
    sourceFile,
    format,
    corpus: buildAuditCorpus(readAuditSources(sourceFile, format), { maxChunkBytes })
  }
}

export function auditCallLimit(audit: AuditSnapshot): number {
  const chunks = audit.corpus.chunks.length
  const groups = Math.min(chunks, audit.clusterGroups)
  // Includes the optional revision and the post-novelty merge even when both prove unnecessary.
  return (
    chunks +
    groups +
    1 +
    audit.agreementSamples * 2 +
    (audit.noveltyLenses.length ? Math.ceil(chunks / 2) + 1 : 0) +
    audit.maxThemes * 3 +
    audit.plannerSeatIds.length +
    audit.judgeSeatIds.length +
    3
  )
}

export function validateAuditSnapshot(
  audit: AuditSnapshot,
  seats: readonly ResolvedLocalWorkflowSeat[]
): void {
  if (!isSupportedAuditRevision(audit.version)) {
    throw new Error('Unsupported audit workflow revision')
  }
  if (!isAbsolute(audit.sourceFile) || !['sources-jsonl', 'digests-jsonl'].includes(audit.format)) {
    throw new Error('Invalid execution-host audit corpus location or format')
  }
  const sourceIds = new Set(audit.corpus.sources.map((source) => source.id))
  const chunkIds = new Set(audit.corpus.chunks.map((chunk) => chunk.id))
  const partition = audit.corpus.chunks.flatMap((chunk) => chunk.sourceIds)
  if (
    audit.corpus.version !== 1 ||
    sourceIds.size !== audit.corpus.sources.length ||
    chunkIds.size !== audit.corpus.chunks.length ||
    partition.length !== sourceIds.size ||
    new Set(partition).size !== sourceIds.size ||
    partition.some((id) => !sourceIds.has(id))
  ) {
    throw new Error('Audit corpus must be a disjoint partition of its source manifest')
  }
  for (const chunk of audit.corpus.chunks) {
    if (
      chunk.bytes !== Buffer.byteLength(chunk.text, 'utf8') ||
      chunk.sha256 !== workflowEvidenceDigest(chunk.text) ||
      chunk.sourceIds.some(
        (id) => audit.corpus.sources.find((source) => source.id === id)?.chunkId !== chunk.id
      )
    ) {
      throw new Error('Audit chunk does not match its manifest')
    }
  }
  assertAuditCluster({ version: 1, findings: audit.existingFindings }, audit.existingFindings)
  if (
    audit.existingFindings.some((finding) =>
      finding.evidence.some((citation) => !sourceIds.has(citation.sourceId))
    )
  ) {
    throw new Error('Existing audit findings must cite the admitted corpus')
  }
  if (
    audit.reference &&
    Object.values(audit.reference).some(
      (value) => typeof value !== 'string' || value.length > 20_000
    )
  ) {
    throw new Error('Audit references must be text at most 20,000 characters each')
  }
  if (
    audit.earlierFindings &&
    (!Array.isArray(audit.earlierFindings.titles) ||
      audit.earlierFindings.titles.length > EARLIER_TITLES_MAX ||
      audit.earlierFindings.titles.some(
        (title) => typeof title !== 'string' || title.length > EARLIER_TITLE_MAX_CHARS
      ))
  ) {
    throw new Error(`Earlier audit titles must be at most ${EARLIER_TITLES_MAX} short lines`)
  }
  if (!audit.corpus.chunks.length || audit.corpus.chunks.length > 64) {
    throw new Error('Audit requires 1–64 chunks')
  }
  if (
    !Number.isInteger(audit.clusterGroups) ||
    audit.clusterGroups < 1 ||
    audit.clusterGroups > 8
  ) {
    throw new Error('Audit requires 1–8 cluster groups')
  }
  if (
    !Number.isInteger(audit.agreementSamples) ||
    audit.agreementSamples < 0 ||
    audit.agreementSamples > audit.corpus.chunks.length
  ) {
    throw new Error('Invalid audit agreement sample count')
  }
  if (!Number.isInteger(audit.maxThemes) || audit.maxThemes < 1 || audit.maxThemes > 24) {
    throw new Error('Audit requires 1–24 themes')
  }
  if (
    audit.noveltyLenses.length > 8 ||
    audit.noveltyLenses.some((lens) => !lens.trim() || lens.length > 200)
  ) {
    throw new Error('Audit permits up to eight bounded novelty lenses')
  }
  if (audit.plannerSeatIds.length !== 3 || audit.judgeSeatIds.length !== 2) {
    throw new Error('Audit requires three planners and two judges')
  }
  const judges = [audit.reviewerSeatId, ...audit.judgeSeatIds, audit.synthesizerSeatId]
  for (const id of [audit.readerSeatId, ...audit.plannerSeatIds, ...judges]) {
    const seat = seats.find((item) => item.id === id)
    if (!seat || (judges.includes(id) && !mayIssueVerdict(seat.agent, seat.model))) {
      throw new Error(`Invalid audit seat: ${id}`)
    }
  }
  if (auditCallLimit(audit) > AUDIT_MAX_CALLS) {
    throw new Error('Audit exceeds the 200-call workflow ceiling')
  }
}
