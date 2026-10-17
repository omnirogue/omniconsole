import type { IncomingMessage } from 'node:http'
import { pipeline, type Transform } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { WebPageReason } from '../../shared/web-page-reason'

export const WEB_PAGE_MAX_BYTES = 2 * 1024 * 1024
export const WEB_PAGE_TYPES: readonly string[] = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json'
]

export type WebPageAnswer =
  | { kind: 'redirect'; location: string }
  | { kind: 'refused'; reason: WebPageReason }
  | { kind: 'body'; contentType: string; charset: string | null; body: Buffer }

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Only a plain media type is kept: the site writes this header, and a reason may repeat it.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/

function mediaType(header: string | undefined): { type: string; charset: string | null } | null {
  const [essence = '', ...parameters] = (header ?? '').split(';')
  const type = essence.trim().toLowerCase()
  if (!MEDIA_TYPE.test(type)) {
    return null
  }
  const charset = parameters
    .map((parameter) => /^\s*charset\s*=\s*"?([^";\s]{1,40})"?\s*$/i.exec(parameter)?.[1])
    .find(Boolean)
  return { type, charset: charset?.toLowerCase() ?? null }
}

function decoderFor(encoding: string): Transform | null | undefined {
  switch (encoding) {
    case '':
    case 'identity':
      return null
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return undefined
  }
}

// The cap counts decompressed bytes, so a small compressed bomb stops at 2 MB of output.
async function readCapped(
  response: IncomingMessage,
  decoder: Transform | null
): Promise<Buffer | null> {
  const source = decoder ? pipeline(response, decoder, () => {}) : response
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of source as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > WEB_PAGE_MAX_BYTES) {
      response.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

/** What one hop's response means: a redirect to follow, a refusal, or a capped, decoded body. */
export async function readWebPageResponse(response: IncomingMessage): Promise<WebPageAnswer> {
  const status = response.statusCode ?? 0
  const location = response.headers.location
  if (REDIRECT_STATUSES.has(status) && location) {
    response.destroy()
    return { kind: 'redirect', location }
  }
  if (status < 200 || status > 299) {
    response.destroy()
    return { kind: 'refused', reason: { code: 'status', status } }
  }
  const media = mediaType(response.headers['content-type'])
  if (!media || !WEB_PAGE_TYPES.includes(media.type)) {
    response.destroy()
    const declared = media ? { contentType: media.type } : {}
    return { kind: 'refused', reason: { code: 'content-type', ...declared } }
  }
  const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase()
  const decoder = decoderFor(encoding)
  if (decoder === undefined) {
    response.destroy()
    return { kind: 'refused', reason: { code: 'network' } }
  }
  if (!decoder && Number(response.headers['content-length']) > WEB_PAGE_MAX_BYTES) {
    response.destroy()
    return { kind: 'refused', reason: { code: 'too-large' } }
  }
  const body = await readCapped(response, decoder)
  if (!body) {
    return { kind: 'refused', reason: { code: 'too-large' } }
  }
  return { kind: 'body', contentType: media.type, charset: media.charset, body }
}
