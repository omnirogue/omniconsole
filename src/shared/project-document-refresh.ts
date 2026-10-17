import type { SessionContextAttachment } from './session-context-attachments'
import {
  SESSION_CONTEXT_DOCUMENT_MAX_CHARS,
  type ResolveContextDocumentRequest,
  type ResolveContextDocumentResult
} from './session-context-documents'

export type ResolveProjectDocument = (
  request: ResolveContextDocumentRequest
) => Promise<ResolveContextDocumentResult>

/**
 * A project's Slite and OmniOS attachments are snapshots taken when they were attached, so a
 * launch re-reads them (backend plan §2e): shared knowledge lives in those documents, and a
 * thread started today must read today's text. A read that fails keeps the snapshot, noted.
 */
export async function refreshProjectDocuments(
  items: readonly SessionContextAttachment[],
  resolve: ResolveProjectDocument
): Promise<{ items: SessionContextAttachment[]; notes: string[] }> {
  const read = await Promise.all(
    items.map(async (item): Promise<{ item: SessionContextAttachment; note?: string }> => {
      const prefix = `${item.kind}:`
      if ((item.kind !== 'slite' && item.kind !== 'omnios') || !item.id.startsWith(prefix)) {
        return { item }
      }
      const result = await resolve({ source: item.kind, id: item.id.slice(prefix.length) }).catch(
        (error: unknown) => ({
          status: 'error' as const,
          message: error instanceof Error ? error.message : String(error)
        })
      )
      if (result.status !== 'ok') {
        return { item, note: `Kept the saved copy of “${item.title}”: ${result.message}` }
      }
      const { document } = result
      return {
        item: {
          ...item,
          title: document.title || item.title,
          uri: document.url || item.uri,
          content: document.content.slice(0, SESSION_CONTEXT_DOCUMENT_MAX_CHARS),
          capturedAt: document.capturedAt,
          truncated:
            document.truncated || document.content.length > SESSION_CONTEXT_DOCUMENT_MAX_CHARS
        }
      }
    })
  )
  return {
    items: read.map((entry) => entry.item),
    notes: read.flatMap((entry) => (entry.note ? [entry.note] : []))
  }
}
