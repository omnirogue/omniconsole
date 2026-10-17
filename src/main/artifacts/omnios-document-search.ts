import type { ArtifactListPage } from '../../shared/artifacts'
import { ARTIFACT_SLUG_PATTERN } from '../../shared/artifact-review'
import type {
  SearchContextDocumentsResult,
  SessionContextDocumentReference
} from '../../shared/session-context-documents'
import { artifactRequest } from './artifact-cloud-request'

export type ArtifactContextSearchPage = Extract<SearchContextDocumentsResult, { status: 'ok' }>

export async function searchOmniosDocuments(
  apiUrl: string,
  token: string,
  query: string,
  startCursor?: string
): Promise<ArtifactContextSearchPage> {
  const documents: SessionContextDocumentReference[] = []
  let cursor = startCursor
  const seenCursors = new Set<string>()
  const term = query.toLowerCase()
  // Older servers only paginate; expose the rest instead of scanning the entire library per keystroke.
  for (let page = 0; page < 4; page++) {
    const path = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const result = await artifactRequest<ArtifactListPage>(apiUrl, token, path)
    for (const { artifact, shareUrl } of result.artifacts) {
      if (artifact.deletedAt || !ARTIFACT_SLUG_PATTERN.test(artifact.slug)) {
        continue
      }
      const title = artifact.title || artifact.originalFileName || artifact.slug
      const haystack =
        `${title}\n${artifact.originalFileName ?? ''}\n${artifact.slug}`.toLowerCase()
      if (!term || haystack.includes(term)) {
        documents.push({
          source: 'omnios',
          id: artifact.slug,
          title,
          url: shareUrl,
          updatedAt: artifact.updatedAt
        })
      }
    }
    cursor = result.nextCursor
    if (!cursor || seenCursors.has(cursor)) {
      cursor = undefined
      break
    }
    seenCursors.add(cursor)
    if (documents.length >= 30 || !term) {
      break
    }
  }
  return { status: 'ok', documents, ...(cursor ? { nextCursor: cursor } : {}) }
}
