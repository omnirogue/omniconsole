import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { getProxyUrlFromEnvironment } from '../../shared/network-proxy'
import { checkWebPageAddress, type WebPageAddress } from '../../shared/web-page-address'
import type { WebPageReason } from '../../shared/web-page-reason'
import { getMainHttpClient } from '../network/http-client'
import {
  pinnedWebLookup,
  resolveWebHost,
  WEB_ADDRESS_BLOCKED,
  WEB_ADDRESS_POLICY,
  type WebAddressPolicy,
  type WebResolver
} from './web-address-policy'
import { readWebPageResponse, WEB_PAGE_TYPES, type WebPageAnswer } from './web-page-response'

export const WEB_PAGE_TIMEOUT_MS = 15_000
export const WEB_PAGE_MAX_REDIRECTS = 5

export type WebPageRequestOptions = {
  /** The run's Stop. Aborting it rejects with its reason instead of recording the page as unreadable. */
  signal?: AbortSignal
  /** Resolves host names; every answer still passes the address policy before a socket sees it. */
  lookup?: WebResolver
  /** The proxy rule for an address; anything other than DIRECT refuses the page. */
  proxyFor?: (url: string) => Promise<string>
  now?: () => number
  /** Tests only: the app always reads through WEB_ADDRESS_POLICY. */
  policy?: WebAddressPolicy
}

export type WebPageResponse =
  | {
      state: 'fetched'
      finalUrl: string
      redirects: string[]
      contentType: string
      charset: string | null
      body: Buffer
      fetchedAt: string
    }
  | { state: 'unreadable'; reason: WebPageReason; redirects: string[] }

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA'])
const DNS_CODES_EXTRA = new Set(['ENODATA', 'ESERVFAIL', 'ENONAME', 'EBADNAME'])
const TLS_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|EPROTO$)|_CERT/

/** The default proxy check: Chromium's rule for the address, or the proxy environment on a Node host. */
export async function webPageProxy(url: string): Promise<string> {
  const session = getMainHttpClient().proxySession()
  if (session) {
    return session.resolveProxy(url)
  }
  const configured = getProxyUrlFromEnvironment(process.env)
  return configured.ok && !configured.value ? 'DIRECT' : 'PROXY environment'
}

// An abort must interrupt a proxy lookup that never answers, not only the socket.
function whenAborted(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  aborted.catch(() => {})
  return aborted
}

async function readsDirect(
  proxyFor: (url: string) => Promise<string>,
  url: string,
  aborted: Promise<never>
): Promise<boolean> {
  try {
    const rule = await Promise.race([proxyFor(url), aborted])
    return rule.trim().toUpperCase() === 'DIRECT'
  } catch {
    return false
  }
}

const userAgent = () =>
  `OmniConsole-web-reader/${hasAppEnvironment() ? getAppEnvironment().getVersion() : 'unknown'}`

function hop(
  address: WebPageAddress,
  lookup: LookupFunction,
  signal: AbortSignal
): Promise<WebPageAnswer> {
  return new Promise((resolve, reject) => {
    const url = new URL(address.href)
    const request = (address.secure ? httpsRequest : httpRequest)({
      host: address.ip ?? address.host,
      port: address.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // A fresh agent per hop: no pooled socket from an earlier, differently resolved hop is reused.
      agent: false,
      lookup,
      signal,
      headers: {
        'User-Agent': userAgent(),
        Accept: WEB_PAGE_TYPES.join(', '),
        'Accept-Encoding': 'gzip, deflate, br'
      }
    })
    // on, not once: a late socket error after the answer must not become an uncaught event.
    request.on('error', reject)
    request.once('response', (response) => {
      readWebPageResponse(response).then(resolve, reject)
    })
    request.end()
  })
}

function reasonFor(error: unknown, secure: boolean): WebPageReason {
  const code = String((error as NodeJS.ErrnoException | null)?.code ?? '')
  if (code === WEB_ADDRESS_BLOCKED) {
    return { code: 'private-address' }
  }
  if (DNS_CODES.has(code) || DNS_CODES_EXTRA.has(code)) {
    return { code: 'dns' }
  }
  return { code: secure && TLS_CODE.test(code) ? 'tls' : 'network' }
}

function redirectTarget(location: string, base: string): string | null {
  try {
    const next = new URL(location, base)
    next.hash = ''
    return next.href
  } catch {
    return null
  }
}

/**
 * GETs one page by hand: every hop re-runs the whole address policy, connects only through the
 * pinned lookup, and sends no cookies, credentials or Referer. Never throws for a page's own failure.
 */
export async function requestWebPage(
  url: string,
  options: WebPageRequestOptions = {}
): Promise<WebPageResponse> {
  options.signal?.throwIfAborted()
  const policy = options.policy ?? WEB_ADDRESS_POLICY
  const lookup = pinnedWebLookup(options.lookup ?? resolveWebHost, policy.blocked)
  const proxyFor = options.proxyFor ?? webPageProxy
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(), WEB_PAGE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal
  const aborted = whenAborted(signal)
  const redirects: string[] = []
  const visited = new Set<string>()
  const unreadable = (reason: WebPageReason): WebPageResponse => ({
    state: 'unreadable',
    reason,
    redirects
  })
  let secure = false
  try {
    for (let current = url; ;) {
      const check = checkWebPageAddress(current, policy.ports)
      if (!check.ok) {
        return unreadable(check.reason)
      }
      const address = check.address
      secure = address.secure
      if (visited.has(address.href)) {
        return unreadable({ code: 'redirects' })
      }
      visited.add(address.href)
      if (address.ip !== null && policy.blocked(address.ip)) {
        return unreadable({ code: 'private-address' })
      }
      const direct = await readsDirect(proxyFor, address.href, aborted)
      signal.throwIfAborted()
      if (!direct) {
        return unreadable({ code: 'proxy' })
      }
      const result = await hop(address, lookup, signal)
      if (result.kind === 'refused') {
        return unreadable(result.reason)
      }
      if (result.kind === 'body') {
        return {
          state: 'fetched',
          finalUrl: address.href,
          redirects,
          contentType: result.contentType,
          charset: result.charset,
          body: result.body,
          fetchedAt: new Date((options.now ?? Date.now)()).toISOString()
        }
      }
      if (redirects.length >= WEB_PAGE_MAX_REDIRECTS) {
        return unreadable({ code: 'redirects' })
      }
      const next = redirectTarget(result.location, address.href)
      if (!next) {
        return unreadable({ code: 'scheme' })
      }
      redirects.push(next)
      if (address.secure && next.startsWith('http:')) {
        return unreadable({ code: 'insecure-redirect' })
      }
      current = next
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason
    }
    return unreadable(timer.signal.aborted ? { code: 'timeout' } : reasonFor(error, secure))
  } finally {
    clearTimeout(timeout)
  }
}
