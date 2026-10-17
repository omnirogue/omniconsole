import type { ArtifactCloudOperation } from '../../shared/artifacts'
import { ARTIFACT_SLUG_PATTERN } from '../../shared/artifact-review'
import { SLITE_DOC_ID_PATTERN } from '../../shared/session-linked-docs'
import {
  SESSION_CONTEXT_DOCUMENT_MAX_CHARS,
  type ResolveContextDocumentRequest,
  type ResolveContextDocumentResult,
  type SearchContextDocumentsRequest,
  type SearchContextDocumentsResult,
  type SessionContextDocumentSnapshot
} from '../../shared/session-context-documents'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import { readSliteDoc } from './slite-doc-reader'
import { searchSliteDocuments, sliteLinkId } from './slite-document-search'
import type { ArtifactContextSearchPage } from './omnios-document-search'

type ContextDocumentRuntime = {
  searchArtifactContextDocuments: (
    query: string,
    cursor?: string
  ) => Promise<ArtifactCloudOperation<ArtifactContextSearchPage>>
  readArtifactContextDocument: (
    id: string
  ) => Promise<ArtifactCloudOperation<SessionContextDocumentSnapshot>>
  getArtifactApiOrigin: () => string | null
}

function artifactLinkId(query: string, origin: string | null): string | null {
  try {
    const url = new URL(query)
    const slug = /^\/a\/([^/]+)(?:\/content)?\/?$/.exec(url.pathname)?.[1]
    return url.origin === origin &&
      !url.username &&
      !url.password &&
      slug &&
      ARTIFACT_SLUG_PATTERN.test(slug)
      ? slug
      : null
  } catch {
    return null
  }
}

function cloudError<T>(result: Exclude<ArtifactCloudOperation<T>, { status: 'ok' }>): {
  status: 'error'
  message: string
} {
  return {
    status: 'error',
    message:
      result.status === 'unconfigured'
        ? result.message
        : 'Sign in to OmniOS again to search and attach artifacts.'
  }
}

function artifactError(error: unknown): { status: 'error'; message: string } {
  if (error instanceof OrcaCloudRequestError) {
    return {
      status: 'error',
      message: [403, 404].includes(error.statusCode)
        ? 'This OmniOS artifact is not visible to your signed-in account.'
        : `OmniOS answered ${error.statusCode}. Try again.`
    }
  }
  return {
    status: 'error',
    message:
      error instanceof Error && error.message.startsWith('This OmniOS artifact')
        ? error.message
        : 'OmniOS could not read these artifacts. Check your connection and try again.'
  }
}

export async function resolveContextDocument(
  request: ResolveContextDocumentRequest,
  runtime: ContextDocumentRuntime
): Promise<ResolveContextDocumentResult> {
  if (request.source === 'slite') {
    if (!SLITE_DOC_ID_PATTERN.test(request.id)) {
      return { status: 'error', message: 'Not a Slite document id.' }
    }
    const result = await readSliteDoc(request.id)
    if (result.status !== 'ok') {
      return { status: 'error', message: result.message }
    }
    return {
      status: 'ok',
      document: {
        source: 'slite',
        id: result.id,
        title: result.title,
        url: result.url,
        updatedAt: result.updatedAt,
        content: result.markdown.slice(0, SESSION_CONTEXT_DOCUMENT_MAX_CHARS),
        contentType: 'text/markdown',
        capturedAt: Date.now(),
        truncated: result.markdown.length > SESSION_CONTEXT_DOCUMENT_MAX_CHARS
      }
    }
  }
  if (!ARTIFACT_SLUG_PATTERN.test(request.id)) {
    return { status: 'error', message: 'Not an OmniOS artifact id.' }
  }
  try {
    const result = await runtime.readArtifactContextDocument(request.id)
    return result.status === 'ok' ? { status: 'ok', document: result.value } : cloudError(result)
  } catch (error) {
    return artifactError(error)
  }
}

export async function searchContextDocuments(
  request: SearchContextDocumentsRequest,
  runtime: ContextDocumentRuntime
): Promise<SearchContextDocumentsResult> {
  const query = request.query.trim()
  const linkId =
    request.source === 'slite'
      ? sliteLinkId(query)
      : artifactLinkId(query, runtime.getArtifactApiOrigin())
  if (linkId) {
    const result = await resolveContextDocument({ source: request.source, id: linkId }, runtime)
    if (result.status !== 'ok') {
      return result
    }
    const { source, id, title, url, updatedAt } = result.document
    return { status: 'ok', documents: [{ source, id, title, url, updatedAt }] }
  }
  if (request.source === 'slite') {
    return searchSliteDocuments(query, request.cursor)
  }
  try {
    const result = await runtime.searchArtifactContextDocuments(query, request.cursor)
    return result.status === 'ok' ? result.value : cloudError(result)
  } catch (error) {
    return artifactError(error)
  }
}
