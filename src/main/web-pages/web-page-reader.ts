import { createHash } from 'node:crypto'
import type { WebPageReason } from '../../shared/web-page-reason'
import { requestWebPage, type WebPageRequestOptions } from './web-page-request'
import { webPageTextOffThread } from './web-page-text-runner'

export type WebPageRead = {
  state: 'read'
  /** Clean text: hidden markup, invisible characters, fences and instruction lines already removed. */
  text: string
  /** Page-written, so only the step that reads the page may ever see it. */
  title: string
  finalUrl: string
  redirects: string[]
  contentType: string
  /** Decompressed bytes fetched. */
  bytes: number
  rawSha256: string
  textSha256: string
  removedLines: number
  truncated: boolean
  /** The decompressed body exactly as fetched. */
  raw: Buffer
  fetchedAt: string
}

export type WebPageUnreadable = {
  state: 'unreadable'
  reason: WebPageReason
  redirects: string[]
}

export type WebPageReading = WebPageRead | WebPageUnreadable

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * Reads one page for a model to cite. An unreadable page carries its reason and nothing else,
 * so no caller can mistake it for content. Rejects only when the caller's signal aborts.
 */
export async function readWebPage(
  url: string,
  options: WebPageRequestOptions = {}
): Promise<WebPageReading> {
  const response = await requestWebPage(url, options)
  if (response.state === 'unreadable') {
    return response
  }
  const page = await webPageTextOffThread(response.body, response.contentType, response.charset, {
    signal: options.signal
  })
  if (!page?.text) {
    return { state: 'unreadable', reason: { code: 'empty' }, redirects: response.redirects }
  }
  return {
    state: 'read',
    text: page.text,
    title: page.title,
    finalUrl: response.finalUrl,
    redirects: response.redirects,
    contentType: response.contentType,
    bytes: response.body.length,
    rawSha256: sha256(response.body),
    textSha256: sha256(page.text),
    removedLines: page.removedLines,
    truncated: page.truncated,
    raw: response.body,
    fetchedAt: response.fetchedAt
  }
}
