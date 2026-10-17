import type {
  SearchContextDocumentsResult,
  SessionContextDocumentReference
} from '../../shared/session-context-documents'
import { SLITE_DOC_ID_PATTERN } from '../../shared/session-linked-docs'
import { SLITE_KEY_MISSING, sliteApiKey } from './slite-doc-reader'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const SLITE_API = 'https://api.slite.com/v1'
const PAGE_SIZE = 30

export function sliteLinkId(query: string): string | null {
  try {
    const url = new URL(query)
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.slite\.com$/.test(url.hostname)) {
      return null
    }
    const id = /^\/(?:app\/docs|api\/s|s)\/([^/]+)/.exec(url.pathname)?.[1]
    return id && SLITE_DOC_ID_PATTERN.test(id) ? id : null
  } catch {
    return null
  }
}

function reference(value: unknown, origin: string): SessionContextDocumentReference | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const hit = value as Record<string, unknown>
  if (typeof hit.id !== 'string' || !SLITE_DOC_ID_PATTERN.test(hit.id)) {
    return null
  }
  return {
    source: 'slite',
    id: hit.id,
    title: typeof hit.title === 'string' ? hit.title.slice(0, 512) : 'Untitled',
    url: `${origin}/app/docs/${hit.id}`,
    updatedAt: typeof hit.lastEditedAt === 'string' ? hit.lastEditedAt : null,
    preview:
      typeof hit.highlight === 'string' ? hit.highlight.replace(/<[^>]*>/g, '').slice(0, 300) : ''
  }
}

export async function searchSliteDocuments(
  query: string,
  cursor?: string
): Promise<SearchContextDocumentsResult> {
  const key = sliteApiKey()
  if (!key) {
    return { status: 'error', message: SLITE_KEY_MISSING }
  }
  if (cursor && !/^\d{1,6}$/.test(cursor)) {
    return { status: 'error', message: 'This Slite search page is invalid. Search again.' }
  }
  const page = Number(cursor ?? 0)
  const params = new URLSearchParams({ query, page: String(page), hitsPerPage: String(PAGE_SIZE) })
  const request = async (path: string) => {
    const response = await fetch(`${SLITE_API}/${path}`, {
      headers: { 'x-slite-api-key': key, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
    // Each concurrent request owns cleanup even when its sibling rejects first.
    try {
      const body: Record<string, unknown> = response.ok ? await response.json() : {}
      return { ok: response.ok, status: response.status, body }
    } finally {
      await cancelUnreadResponseBody(response)
    }
  }
  try {
    // Slite search hits omit URLs; /me supplies the account's actual workspace domain.
    const [response, meResponse] = await Promise.all([
      request(`search-notes?${params}`),
      request('me')
    ])
    if (!response.ok || !meResponse.ok) {
      const status = !response.ok ? response.status : meResponse.status
      return {
        status: 'error',
        message:
          status === 401 || status === 403
            ? 'Your Slite API key cannot search these documents. Reconnect Slite.'
            : `Slite search answered ${status}.`
      }
    }
    const body = response.body
    const me = meResponse.body
    const domain =
      typeof me.organizationDomain === 'string'
        ? me.organizationDomain.replace(/\.slite\.com$/, '')
        : ''
    if (!/^[a-z0-9-]{1,63}$/.test(domain) || !Array.isArray(body.hits)) {
      return { status: 'error', message: 'Slite returned an unreadable search response.' }
    }
    const documents = body.hits.slice(0, PAGE_SIZE).flatMap((hit: unknown) => {
      const doc = reference(hit, `https://${domain}.slite.com`)
      return doc ? [doc] : []
    })
    return {
      status: 'ok',
      documents,
      ...(typeof body.nbPages === 'number' && page + 1 < body.nbPages
        ? { nextCursor: String(page + 1) }
        : {})
    }
  } catch {
    return { status: 'error', message: 'Slite search could not be reached. Try again.' }
  }
}
