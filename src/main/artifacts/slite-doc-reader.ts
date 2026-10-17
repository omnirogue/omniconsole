/**
 * Reads one Slite doc as Markdown for the right panel, with the person's own Slite API key — the
 * same sources `slite-kb` uses — so what shows follows their Slite permissions. The key stays in
 * this process: the renderer only ever receives the doc's title and Markdown.
 */

import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { SLITE_DOC_ID_PATTERN } from '../../shared/session-linked-docs'
import type { SliteDocResult } from '../../shared/slite-doc'
import { readPrivateVault } from '../runtime/workflow-script/workflow-gemini-key'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const SLITE_API = 'https://api.slite.com/v1'
const SLITE_REQUEST_TIMEOUT_MS = 15_000
const SLITE_DOC_MAX_CHARS = 2_000_000
const SLITE_DOC_CACHE_MS = 20_000
const KEY_NAMES = ['SLITE_API_KEY', 'OMNIROGUE_SLITE_API_KEY'] as const

export const SLITE_KEY_MISSING =
  'Showing Slite docs here needs your Slite API key: SLITE_API_KEY, ~/.config/slite-kb/api-key or OMNIROGUE_SLITE_API_KEY in ~/.config/omni/connections.env (mode 600).'

function dotenvValue(text: string, name: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    const separator = line.indexOf('=')
    if (line.startsWith('#') || separator < 1 || line.slice(0, separator).trim() !== name) {
      continue
    }
    const value = line.slice(separator + 1).trim()
    const quote = value[0]
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1
    return (close > 0 ? value.slice(1, close) : value.replace(/\s+#.*$/, '')).trim() || undefined
  }
  return undefined
}

/** The person's Slite key: environment, then slite-kb's key file, then the credential vault. */
export function sliteApiKey(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | undefined {
  for (const name of KEY_NAMES) {
    const ambient = environment[name]?.trim()
    if (ambient) {
      return ambient
    }
  }
  // Why only private files, and never on Windows: there is no POSIX mode to prove them private.
  if (!home || platform === 'win32') {
    return undefined
  }
  const own = readPrivateVault(join(home, '.config', 'slite-kb', 'api-key'))
  const ownKey = own && 'text' in own ? own.text.trim() : ''
  if (ownKey && !ownKey.includes('\n')) {
    return ownKey
  }
  const vault = readPrivateVault(join(home, '.config', 'omni', 'connections.env'))
  return vault && 'text' in vault ? dotenvValue(vault.text, 'OMNIROGUE_SLITE_API_KEY') : undefined
}

type CachedDoc = { at: number; result: SliteDocResult }
const cache = new Map<string, CachedDoc>()

export async function readSliteDoc(
  id: string,
  deps: {
    key?: () => string | undefined
    fetchImpl?: typeof fetch
    now?: () => number
  } = {}
): Promise<SliteDocResult> {
  if (!SLITE_DOC_ID_PATTERN.test(id)) {
    return { status: 'error', message: 'Not a Slite doc id.' }
  }
  const key = (deps.key ?? sliteApiKey)()
  if (!key) {
    return { status: 'no-key', message: SLITE_KEY_MISSING }
  }
  const now = (deps.now ?? Date.now)()
  // A changed Slite account must never receive the previous key's cached document.
  const cacheKey = `${createHash('sha256').update(key).digest('hex')}:${id}`
  const cached = cache.get(cacheKey)
  if (cached && now - cached.at < SLITE_DOC_CACHE_MS) {
    return cached.result
  }
  let result: SliteDocResult
  let response: Response | undefined
  try {
    response = await (deps.fetchImpl ?? globalThis.fetch)(
      `${SLITE_API}/notes/${encodeURIComponent(id)}?format=md`,
      {
        headers: { 'x-slite-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(SLITE_REQUEST_TIMEOUT_MS)
      }
    )
    if (!response.ok) {
      result = {
        status: 'error',
        message:
          response.status === 404 || response.status === 403
            ? 'This Slite doc is not visible to your Slite account.'
            : `Slite answered ${response.status}.`
      }
    } else {
      const body = (await response.json()) as Record<string, unknown>
      const markdown = typeof body.content === 'string' ? body.content : ''
      result = {
        status: 'ok',
        id,
        title: typeof body.title === 'string' && body.title ? body.title : 'Untitled',
        markdown: markdown.slice(0, SLITE_DOC_MAX_CHARS),
        url: typeof body.url === 'string' && body.url.startsWith('https://') ? body.url : '',
        updatedAt:
          typeof body.lastEditedAt === 'string'
            ? body.lastEditedAt
            : typeof body.updatedAt === 'string'
              ? body.updatedAt
              : null
      }
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return {
      status: 'error',
      message: timedOut ? 'Slite did not answer in time.' : 'Slite could not be reached.'
    }
  } finally {
    if (response) {
      await cancelUnreadResponseBody(response)
    }
  }
  cache.set(cacheKey, { at: now, result })
  // Why a bound: ids come from replies; the cache must not grow with every doc ever linked.
  if (cache.size > 200) {
    cache.delete(cache.keys().next().value!)
  }
  return result
}
