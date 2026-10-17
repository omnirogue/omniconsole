import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  readFetchResponseJsonWithinLimit,
  readFetchResponseTextWithinLimit
} from '../../shared/fetch-response-body'
import { BACKOFFICE_POLLING } from '../../shared/backoffice-polling-cadence'

type Entry = { etag: string; body: unknown }
const entries = new Map<string, Entry>()
type CachedRead = { response: Response; body?: unknown; notModified?: true; errorBody?: string }
const pending = new Map<string, Promise<CachedRead>>()

function forCaller(read: CachedRead): CachedRead {
  return !read.response.ok && !read.notModified
    ? {
        ...read,
        response: new Response(read.errorBody, {
          status: read.response.status,
          headers: read.response.headers
        })
      }
    : read
}
const MAX_ENTRIES = 256

/** Credentials and origin fence validators; a 304 retains the body for older IPC consumers. */
export function readBackofficeCached(url: string, bearer?: string) {
  const key = JSON.stringify([url, bearer ?? ''])
  const existing = pending.get(key)
  if (existing) {
    return existing.then(forCaller)
  }
  const promise = (async () => {
    const cached = entries.get(key)
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(BACKOFFICE_POLLING.requestTimeoutMs),
      headers: {
        accept: 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(cached ? { 'If-None-Match': cached.etag } : {})
      }
    })
    try {
      if (response.status === 304) {
        return cached ? { response, body: cached.body, notModified: true as const } : { response }
      }
      if (!response.ok) {
        entries.delete(key)
        if (response.status === 410) {
          // A stale cursor is identified by status; cancel its stream once without reading it.
          return { response }
        }
        return { response, errorBody: await readFetchResponseTextWithinLimit(response) }
      }
      const body: unknown = await readFetchResponseJsonWithinLimit(response)
      const etag = response.headers.get('etag')
      entries.delete(key)
      if (etag && !/\bno-store\b/i.test(response.headers.get('cache-control') ?? '')) {
        entries.set(key, { etag, body })
        while (entries.size > MAX_ENTRIES) {
          entries.delete(entries.keys().next().value!)
        }
      }
      return { response, body }
    } finally {
      // The shared operation owns cleanup; coalesced callers never inherit a live network body.
      await cancelUnreadResponseBody(response)
    }
  })()
  pending.set(key, promise)
  void promise
    .finally(() => {
      pending.delete(key)
    })
    .catch(() => undefined)
  return promise.then(forCaller)
}
