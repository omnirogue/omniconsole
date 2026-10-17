import { readFetchResponseBytesWithinLimit } from '../../shared/fetch-response-body'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { getMainHttpClient } from '../network/http-client'
import { OLDACS_ACCOUNT_ID } from './typesafe-advertising-local-scope'

export type LocalMetaReaderIdentity = {
  token: string
  isCurrent: () => boolean
  assertCurrent?: () => Promise<void>
}
export type LocalMetaReaderOptions = { fetch?: typeof globalThis.fetch; now?: () => number }
export type LocalMetaGetResult = { value: unknown; collectedAt: string }
export type LocalMetaListResult = { rows: unknown[]; collectedAt: string }
export type LocalMetaReader = {
  get(path: string, params: Record<string, string>): Promise<LocalMetaGetResult>
  list(path: string, params: Record<string, string>): Promise<LocalMetaListResult>
}

const ORIGIN = 'https://graph.facebook.com'
const VERSION = '/v21.0/'
const BODY_BYTES = 1024 * 1024
const TOTAL_BYTES = 16 * BODY_BYTES
const MAX_REQUESTS = 160
const MAX_PAGES = 5
const MAX_ROWS = 100
const REQUEST_MS = 10_000
const READER_MS = 90_000
const MESSAGE = 'Local Meta evidence is unavailable.'
const PARAM_VALUES: Record<string, RegExp> = {
  fields: /^[a-z_][a-z_0-9]*(?:,[a-z_][a-z_0-9]*)*$/,
  date_preset: /^[a-z][a-z_0-9]{0,39}$/,
  level: /^(account|campaign|adset|ad)$/,
  time_increment: /^(all_days|[1-9]|[1-8][0-9]|90)$/,
  limit: /^([1-9]|[1-9][0-9]|100)$/,
  after: /^[A-Za-z0-9_+/-]{1,2048}={0,2}$/,
  action_report_time: /^(impression|conversion|mixed)$/,
  use_account_attribution_setting: /^(true|false)$/
}
function unavailable(): never {
  throw new Error(MESSAGE)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function cursor(value: unknown): value is string {
  return typeof value === 'string' && PARAM_VALUES.after.test(value)
}
function requestUrl(path: string, params: Record<string, string>): URL {
  const native = path.replace(/^\//, '')
  const id = native.replace(/\/insights$/, '')
  if (
    (id !== OLDACS_ACCOUNT_ID && !/^[1-9][0-9]{4,29}$/.test(id)) ||
    (native !== id && native !== `${id}/insights`)
  ) {
    unavailable()
  }
  const url = new URL(VERSION + native, ORIGIN)
  for (const [key, value] of Object.entries(params)) {
    if (
      !Object.hasOwn(PARAM_VALUES, key) ||
      typeof value !== 'string' ||
      value.length > 4096 ||
      !PARAM_VALUES[key].test(value)
    ) {
      unavailable()
    }
    url.searchParams.set(key, value)
  }
  return url
}

function validatePageLink(value: unknown, current: URL, key: 'after' | 'before'): string {
  if (typeof value !== 'string' || value.length > 16_384) {
    unavailable()
  }
  const link = new URL(value)
  if (
    link.origin !== ORIGIN ||
    link.pathname !== current.pathname ||
    link.username ||
    link.password ||
    link.hash
  ) {
    unavailable()
  }
  const keys = new Set<string>()
  for (const [name, field] of link.searchParams) {
    if (keys.has(name)) {
      unavailable()
    }
    keys.add(name)
    // Graph may echo credentials in links; they are never copied into a request.
    if (name === 'access_token') {
      continue
    }
    if (name !== key && field !== current.searchParams.get(name)) {
      unavailable()
    }
    if (name !== key && !Object.hasOwn(PARAM_VALUES, name)) {
      unavailable()
    }
  }
  const next = link.searchParams.get(key)
  if (!cursor(next)) {
    unavailable()
  }
  return next
}

function nextCursor(value: Record<string, unknown>, url: URL): string | null {
  if (!Object.hasOwn(value, 'paging')) {
    return null
  }
  const paging = value.paging
  if (
    !record(paging) ||
    Object.keys(paging).some((key) => !['next', 'previous', 'cursors'].includes(key))
  ) {
    unavailable()
  }
  const cursors = paging.cursors
  if (
    cursors !== undefined &&
    (!record(cursors) ||
      Object.entries(cursors).some(
        ([key, field]) => !['after', 'before'].includes(key) || !cursor(field)
      ))
  ) {
    unavailable()
  }
  if (Object.hasOwn(paging, 'previous')) {
    const previous = validatePageLink(paging.previous, url, 'before')
    if (!record(cursors) || cursors.before !== previous) {
      unavailable()
    }
  }
  if (!Object.hasOwn(paging, 'next')) {
    return null
  }
  const next = validatePageLink(paging.next, url, 'after')
  if (!record(cursors) || cursors.after !== next) {
    unavailable()
  }
  return next
}

export function createLocalMetaReader(
  identity: LocalMetaReaderIdentity,
  options: LocalMetaReaderOptions = {}
): LocalMetaReader {
  const { token, isCurrent } = identity
  const http = getMainHttpClient()
  const fetcher = options.fetch ?? http.fetch.bind(http)
  const now = options.now ?? Date.now
  const deadline = now() + READER_MS
  let requests = 0
  let bytes = 0
  let failed = false
  let pending: Promise<unknown> = Promise.resolve()

  function assertCurrent(): void {
    if (failed || !isCurrent() || !Number.isFinite(now()) || now() >= deadline) {
      unavailable()
    }
  }

  async function assertIdentity(): Promise<void> {
    assertCurrent()
    await identity.assertCurrent?.()
    assertCurrent()
  }

  async function request(url: URL): Promise<LocalMetaGetResult> {
    let response: Response | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    try {
      assertCurrent()
      if (!token || /\s/.test(token) || requests >= MAX_REQUESTS || bytes >= TOTAL_BYTES) {
        unavailable()
      }
      requests += 1
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            failed = true
            controller.abort()
            reject(new Error(MESSAGE))
          },
          Math.min(REQUEST_MS, deadline - now())
        )
      })
      const read = async (): Promise<LocalMetaGetResult> => {
        await assertIdentity()
        response = await fetcher(url.href, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal
        })
        try {
          await assertIdentity()
          if (!response.ok || response.redirected || (response.url && response.url !== url.href)) {
            unavailable()
          }
          const body = await readFetchResponseBytesWithinLimit(
            response,
            Math.min(BODY_BYTES, TOTAL_BYTES - bytes)
          )
          await assertIdentity()
          bytes += body.byteLength
          const content = new TextDecoder('utf-8', { fatal: true }).decode(body)
          assertJsonTextStructureWithinLimits(content, {
            structuralTokens: 100_000,
            nestingDepth: 32
          })
          const value: unknown = JSON.parse(content)
          if (!record(value) || Object.hasOwn(value, 'error')) {
            unavailable()
          }
          assertCurrent()
          return { value, collectedAt: new Date(now()).toISOString() }
        } finally {
          void cancelUnreadResponseBody(response)
        }
      }
      return await Promise.race([read(), timeout])
    } catch {
      failed = true
      controller.abort()
      return unavailable()
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (response) {
        void cancelUnreadResponseBody(response)
      }
    }
  }

  function get(path: string, params: Record<string, string>): Promise<LocalMetaGetResult> {
    // Serialization keeps byte and request budgets shared across concurrent callers.
    const result = pending.then(async () => {
      try {
        return await request(requestUrl(path, params))
      } catch {
        failed = true
        unavailable()
      }
    })
    pending = result.catch(() => undefined)
    return result
  }

  async function list(path: string, params: Record<string, string>): Promise<LocalMetaListResult> {
    try {
      const url = requestUrl(path, params)
      const seen = new Set<string>(params.after ? [params.after] : [])
      const rows: unknown[] = []
      let collectedAt = ''
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await get(path, Object.fromEntries(url.searchParams))
        assertCurrent()
        const value = result.value
        if (
          !record(value) ||
          !Array.isArray(value.data) ||
          Object.keys(value).some((key) => !['data', 'paging'].includes(key)) ||
          value.data.some((row) => !record(row)) ||
          rows.length + value.data.length > MAX_ROWS
        ) {
          unavailable()
        }
        rows.push(...value.data)
        collectedAt ||= result.collectedAt
        const after = nextCursor(value, url)
        if (after === null) {
          return { rows, collectedAt }
        }
        if (!value.data.length || rows.length >= MAX_ROWS || seen.has(after)) {
          unavailable()
        }
        seen.add(after)
        url.searchParams.set('after', after)
      }
      unavailable()
    } catch {
      failed = true
      unavailable()
    }
  }

  return { get, list }
}
