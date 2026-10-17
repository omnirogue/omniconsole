import { workflowEvidenceDigest } from '../workflow-evidence-digest'
import type { GraphJevStore } from '../graph/graph-jev-store'
import { verifyAuditEvidence, type AuditEvidenceResult } from './audit-evidence'
import { readAuditSources, type AuditSnapshot } from './audit-snapshot'
import type { AuditCitation } from '../../../../shared/workflow-audit-contracts'
import type { AuditSource } from './audit-corpus'
import { assertAuditEvidencePacket } from './audit-cache-validation'
import { WorkflowCacheMissError } from '../workflow-cache-miss'
import { readAuditCacheRecord } from './audit-cache-record'

export type AuditEvidencePacket = {
  check: AuditEvidenceResult
  excerpts: { sourceId: string; quote: string; surrounding: string }[]
}
export type AuditCheckEvidence = (citations: AuditCitation[]) => Promise<AuditEvidencePacket>

/** Source checks are durable host facts; completed replay never reopens a corpus. */
export function createAuditEvidenceReader(
  audit: AuditSnapshot,
  store: GraphJevStore,
  cacheOnly = false
): AuditCheckEvidence {
  return async (citations) => {
    const digest = workflowEvidenceDigest(
      JSON.stringify({ version: audit.version, sources: audit.corpus.sources, citations })
    )
    const id = `audit/evidence/${digest}`
    const cached = readAuditCacheRecord(store, id, digest)
    if (cached) {
      return assertAuditEvidencePacket(cached.value, citations, audit.corpus.sources)
    }
    if (cacheOnly) {
      throw new WorkflowCacheMissError(id)
    }
    let sources: Map<string, AuditSource> | undefined
    const load = async (sourceId: string) => {
      if (!sources) {
        const fresh = readAuditSources(audit.sourceFile, audit.format)
        if (new Set(fresh.map((source) => source.id)).size !== fresh.length) {
          throw new Error('Duplicate source IDs in changed corpus')
        }
        sources = new Map(fresh.map((source) => [source.id, source]))
      }
      return sources.get(sourceId) ?? null
    }
    const check = await verifyAuditEvidence(citations, audit.corpus.sources, load)
    const excerpts = check.citations
      .filter((citation) => citation.status === 'verified')
      .map(({ sourceId, quote }) => {
        const text = sources!.get(sourceId)!.text
        const at = text.indexOf(quote)
        return {
          sourceId,
          quote,
          surrounding: text.slice(Math.max(0, at - 800), at + quote.length + 800)
        }
      })
    const packet = { check, excerpts }
    assertAuditEvidencePacket(packet, citations, audit.corpus.sources)
    store.write(id, { digest, outcome: { value: packet }, at: Date.now() })
    return packet
  }
}
