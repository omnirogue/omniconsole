import type { WebPageReason } from './web-page-reason'

export const WEB_PAGE_PORTS: readonly number[] = [80, 443]

/** A web address that passed the syntactic checks. IP and DNS checks happen in main. */
export type WebPageAddress = {
  /** The normalised address without its fragment. */
  href: string
  secure: boolean
  /** The host as a resolver sees it: IPv6 without brackets. */
  host: string
  port: number
  /** Set when the host is an IP literal, which never reaches a resolver. */
  ip: string | null
}

export type WebPageAddressCheck =
  | { ok: true; address: WebPageAddress }
  | { ok: false; reason: WebPageReason }

// WHATWG URL rewrites every IPv4 spelling (127.1, 0x7f000001, 0177.0.0.1) to four decimal parts.
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

const refuse = (code: WebPageReason['code']): WebPageAddressCheck => ({
  ok: false,
  reason: { code }
})

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** Scheme, credentials, port and localhost names: everything that needs no network to decide. */
export function checkWebPageAddress(
  raw: string,
  ports: readonly number[] = WEB_PAGE_PORTS
): WebPageAddressCheck {
  const url = parse(raw)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return refuse('scheme')
  }
  if (url.username || url.password) {
    return refuse('credentials')
  }
  const secure = url.protocol === 'https:'
  const port = url.port ? Number(url.port) : secure ? 443 : 80
  if (!ports.includes(port)) {
    return refuse('port')
  }
  const bracketed = url.hostname.startsWith('[')
  const host = bracketed ? url.hostname.slice(1, -1) : url.hostname
  const name = host.replace(/\.+$/, '')
  if (name === 'localhost' || name.endsWith('.localhost')) {
    return refuse('private-address')
  }
  url.hash = ''
  const ip = bracketed || IPV4.test(host) ? host : null
  return { ok: true, address: { href: url.href, secure, host, port, ip } }
}
