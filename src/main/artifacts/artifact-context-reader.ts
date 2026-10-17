import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import { artifactContentUrl } from '../../shared/artifact-session'
import {
  SESSION_CONTEXT_DOCUMENT_MAX_CHARS,
  type SessionContextDocumentSnapshot
} from '../../shared/session-context-documents'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import { artifactRequest } from './artifact-cloud-request'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const MAX_DOCUMENT_BYTES = 2_000_000

async function readContent(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error('This OmniOS artifact has no document content.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > MAX_DOCUMENT_BYTES) {
        throw new Error(
          'This OmniOS artifact is too large to attach. Add a smaller document or its link as instructions.'
        )
      }
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Text extraction for model context only; the result is never rendered as HTML. */
function documentText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  }
  return html
    .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:p|div|h[1-6]|li|br|tr|section|article|pre|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      if (!entity.startsWith('#')) {
        return entities[entity.toLowerCase()] ?? match
      }
      const code =
        entity[1].toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function readArtifactContext(
  apiUrl: string,
  token: string,
  slug: string
): Promise<SessionContextDocumentSnapshot> {
  const metadata = await artifactRequest<ArtifactReviewStatus>(
    apiUrl,
    token,
    `/${encodeURIComponent(slug)}/review`
  )
  const response = await fetch(artifactContentUrl(apiUrl, slug), {
    headers: { authorization: `Bearer ${token}`, accept: 'text/html, text/markdown, text/plain' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000)
  })
  try {
    if (!response.ok) {
      throw new OrcaCloudRequestError(response.status)
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim()
    if (type !== 'text/html' && type !== 'text/markdown' && type !== 'text/plain') {
      throw new Error('This OmniOS artifact is not a text document.')
    }
    const raw = await readContent(response)
    const extracted = type === 'text/html' ? documentText(raw) : raw
    // Script-rendered artifacts still carry useful source even without static body text.
    const sourceOnly = type === 'text/html' && !extracted.trim()
    const content = sourceOnly ? raw : extracted
    if (!content.trim()) {
      throw new Error('This OmniOS artifact has no readable text to attach.')
    }
    return {
      source: 'omnios',
      id: slug,
      title: metadata.artifact.title || metadata.artifact.originalFileName || slug,
      url: `${apiUrl}/a/${encodeURIComponent(slug)}`,
      updatedAt: metadata.artifact.updatedAt,
      content: content.slice(0, SESSION_CONTEXT_DOCUMENT_MAX_CHARS),
      contentType: sourceOnly ? 'text/html' : 'text/markdown',
      capturedAt: Date.now(),
      truncated: content.length > SESSION_CONTEXT_DOCUMENT_MAX_CHARS
    }
  } finally {
    await cancelUnreadResponseBody(response)
  }
}
