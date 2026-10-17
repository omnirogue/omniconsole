import { workflowEvidenceDigest } from '../workflow-evidence-digest'
import { auditTimestamp, type AuditSource, type AuditSourceManifest } from './audit-corpus'

export type AuditCitation = { sourceId: string; quote: string }
export type AuditEvidenceStatus =
  | 'verified'
  | 'source-not-registered'
  | 'source-missing'
  | 'source-unreadable'
  | 'source-id-mismatch'
  | 'source-changed'
  | 'quote-not-found'
  | 'invalid-quote'
export type AuditEvidenceResult = {
  citations: (AuditCitation & { status: AuditEvidenceStatus })[]
  citedSourceCount: number
  verifiedSourceCount: number
  allVerified: boolean
}
export type AuditSourceLoader = (sourceId: string) => Promise<AuditSource | null>
type LoadedSource = { text: string; status: 'verified' } | { status: AuditEvidenceStatus }

async function rereadSource(
  manifest: AuditSourceManifest,
  loadSource: AuditSourceLoader
): Promise<LoadedSource> {
  let source: AuditSource | null
  try {
    source = await loadSource(manifest.id)
  } catch {
    return { status: 'source-unreadable' }
  }
  if (!source) {
    return { status: 'source-missing' }
  }
  if (source.id !== manifest.id) {
    return { status: 'source-id-mismatch' }
  }
  try {
    if (
      typeof source.text !== 'string' ||
      auditTimestamp(source.timestamp) !== manifest.timestamp ||
      Buffer.byteLength(source.text, 'utf8') !== manifest.bytes ||
      workflowEvidenceDigest(source.text) !== manifest.sha256
    ) {
      return { status: 'source-changed' }
    }
  } catch {
    return { status: 'source-changed' }
  }
  return { text: source.text, status: 'verified' }
}

/** The execution host supplies the loader; citations can select registered IDs, never paths. */
export async function verifyAuditEvidence(
  citations: readonly AuditCitation[],
  manifest: readonly AuditSourceManifest[],
  loadSource: AuditSourceLoader
): Promise<AuditEvidenceResult> {
  const registry = new Map(manifest.map((source) => [source.id, source]))
  if (registry.size !== manifest.length) {
    throw new Error('Duplicate IDs in audit source manifest')
  }
  const loaded = new Map<string, LoadedSource>()
  const results: AuditEvidenceResult['citations'] = []
  for (const citation of citations) {
    let status: AuditEvidenceStatus
    const registered = registry.get(citation.sourceId)
    if (typeof citation.quote !== 'string' || !citation.quote.trim()) {
      status = 'invalid-quote'
    } else if (!registered) {
      status = 'source-not-registered'
    } else {
      let source = loaded.get(registered.id)
      if (!source) {
        source = await rereadSource(registered, loadSource)
        loaded.set(registered.id, source)
      }
      status =
        'text' in source
          ? source.text.includes(citation.quote)
            ? 'verified'
            : 'quote-not-found'
          : source.status
    }
    results.push({ ...citation, status })
  }
  return {
    citations: results,
    citedSourceCount: new Set(citations.map((citation) => citation.sourceId)).size,
    verifiedSourceCount: new Set(
      results.filter((item) => item.status === 'verified').map((item) => item.sourceId)
    ).size,
    allVerified: results.length > 0 && results.every((item) => item.status === 'verified')
  }
}
