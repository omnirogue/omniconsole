import type { NativeChatMessage } from './native-chat-types'
import { parseLoopbackUrlWithPort } from './localhost-worktree-labels'

/**
 * Links a conversation produced that a person may want to open again: private claude.ai
 * artifacts, a local dev server, a deploy preview, a GitHub pull request, or a place finished work
 * lives (Drive, Docs, Notion, Figma, Meta, YouTube…). Everything else the transcript mentions
 * (docs, search results, API endpoints) is left out on purpose.
 */
export type SessionLinkKind = 'artifact' | 'localhost' | 'preview' | 'pull-request' | 'service'

export type SessionLink = {
  kind: SessionLinkKind
  /** The matched URL with trailing prose punctuation removed. */
  url: string
  /** Dedupe identity: lower-cased host, no fragment, no trailing slash. */
  key: string
  /** Index of the latest message that mentioned it; larger is newer. */
  messageIndex: number
  pullRequest?: { owner: string; repo: string; number: number }
  /** The service a `service` link opens ("Google Drive"). */
  service?: string
}

/** Hosting platforms whose sub-domains are per-deploy previews. The apex itself is not one. */
const PREVIEW_PLATFORM_SUFFIXES = [
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'github.io',
  'onrender.com',
  'fly.dev'
]
/** Sal's own domains: the apex and any sub-domain count. */
const OWNED_PREVIEW_DOMAINS = [
  'omnirogue.com',
  'betacorp.com',
  'example.edu',
  'apexlabs.ai'
]

/** Where finished work lives outside the app; the host (or its parent) names the service. */
const WORK_SERVICES: Readonly<Record<string, string>> = {
  'drive.google.com': 'Google Drive',
  'docs.google.com': 'Google Docs',
  'notion.so': 'Notion',
  'notion.site': 'Notion',
  'figma.com': 'Figma',
  'canva.com': 'Canva',
  'business.facebook.com': 'Meta Business',
  'adsmanager.facebook.com': 'Meta Ads Manager',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'vimeo.com': 'Vimeo',
  'loom.com': 'Loom',
  'dropbox.com': 'Dropbox',
  'frame.io': 'Frame.io',
  'webinarjam.com': 'WebinarJam',
  'airtable.com': 'Airtable'
}

/** The work service a host belongs to, matching the host or any parent domain. */
export function workServiceForHost(hostname: string): string | null {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.')
  for (let start = 0; start < labels.length - 1; start += 1) {
    const service = WORK_SERVICES[labels.slice(start).join('.')]
    if (service) {
      return service
    }
  }
  return null
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?*_~'"]+$/
/** A tool result can be megabytes of log; links past this point are not worth the scan. */
const MAX_SCANNED_CHARS = 200_000

/** Strip prose punctuation and unbalanced closing brackets that a URL match swallowed. */
export function trimMatchedUrl(raw: string): string {
  let url = raw
  for (;;) {
    const before = url
    url = url.replace(TRAILING_PUNCTUATION, '')
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}']
    ] as const) {
      if (url.endsWith(close) && url.split(close).length > url.split(open).length) {
        url = url.slice(0, -1)
      }
    }
    if (url === before) {
      return url
    }
  }
}

export function normalizeLinkKey(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`
  } catch {
    return url
  }
}

function hostMatches(host: string, domain: string, allowApex: boolean): boolean {
  return host.endsWith(`.${domain}`) || (allowApex && host === domain)
}

export function isPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return (
    PREVIEW_PLATFORM_SUFFIXES.some((domain) => hostMatches(host, domain, false)) ||
    OWNED_PREVIEW_DOMAINS.some((domain) => hostMatches(host, domain, true))
  )
}

export function parseGitHubPullRequestUrl(
  url: string
): { owner: string; repo: string; number: number; url: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !/^(www\.)?github\.com$/i.test(parsed.hostname)) {
    return null
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(parsed.pathname)
  if (!match) {
    return null
  }
  const [, owner, repo, digits] = match
  const number = Number(digits)
  return {
    owner: owner!,
    repo: repo!,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`
  }
}

/** Path roots of machine endpoints: a person never opens these to look at the work. */
const MACHINE_PATH_ROOTS: ReadonlySet<string> = new Set([
  'api',
  'graphql',
  'health',
  'healthz',
  'livez',
  'readyz',
  'metrics',
  'webhook',
  'webhooks'
])
const TEMPLATE_PLACEHOLDER = /[{}]|%7b|%7d/i

/**
 * A URL no person opens: a template with `{placeholders}`, an `api.`/`api-` host, a health or API
 * path, or a loopback port below 1024 (never a dev server; e.g. a probe's `127.0.0.1:1`).
 */
export function isMachineOrTemplateUrl(url: string): boolean {
  if (TEMPLATE_PLACEHOLDER.test(url)) {
    return true
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return true
  }
  const labels = parsed.hostname.toLowerCase().split('.')
  if (labels.some((label) => label === 'api' || label.startsWith('api-'))) {
    return true
  }
  const root = parsed.pathname
    .split('/')
    .find((part) => part.length > 0)
    ?.toLowerCase()
  if (root && MACHINE_PATH_ROOTS.has(root)) {
    return true
  }
  const port = Number(parsed.port)
  return parsed.port !== '' && port < 1024 && port !== 80 && port !== 443
}

/** The pull request a preview host was deployed for (`pr-1003.preview.…`), or null. */
export function previewPullRequestNumber(url: string): number | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const first = host.split('.')[0] ?? ''
  const match = /^(?:.*-)?pr-?(\d+)$/.exec(first) ?? /^deploy-preview-(\d+)(?:--|$)/.exec(first)
  return match ? Number(match[1]) : null
}

/** A brand's own home page (`omnirogue.com`, `www.betacorp.com/`): mentioned often, rarely the work. */
export function isOwnedSiteRoot(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  return OWNED_PREVIEW_DOMAINS.includes(host) && parsed.pathname.replace(/\/+$/, '') === ''
}

function isClaudeArtifactUrl(parsed: URL): boolean {
  return (
    parsed.protocol === 'https:' &&
    /^(www\.)?claude\.ai$/i.test(parsed.hostname) &&
    /^\/(code\/)?artifacts?\/[^/]+/.test(parsed.pathname)
  )
}

/** What kind of session link a URL is, or null when it is not one the panel lists. */
export function classifySessionLink(
  url: string
): Pick<SessionLink, 'kind' | 'url' | 'pullRequest' | 'service'> | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) {
    // Why: never surface (or later open) a URL that carries credentials.
    return null
  }
  const pullRequest = parseGitHubPullRequestUrl(url)
  if (pullRequest) {
    const { url: canonical, ...identity } = pullRequest
    return { kind: 'pull-request', url: canonical, pullRequest: identity }
  }
  if (isClaudeArtifactUrl(parsed)) {
    return { kind: 'artifact', url }
  }
  if (isMachineOrTemplateUrl(url)) {
    return null
  }
  if (parseLoopbackUrlWithPort(url)) {
    return { kind: 'localhost', url }
  }
  if (parsed.protocol === 'https:' && isPreviewHost(parsed.hostname)) {
    return { kind: 'preview', url }
  }
  const service = parsed.protocol === 'https:' ? workServiceForHost(parsed.hostname) : null
  return service ? { kind: 'service', url, service } : null
}

/** The session links one piece of text mentions, in order, not yet deduped. */
export function sessionLinksInText(
  text: string
): Pick<SessionLink, 'kind' | 'url' | 'pullRequest' | 'service'>[] {
  if (!text.includes('http')) {
    return []
  }
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text
  const links: Pick<SessionLink, 'kind' | 'url' | 'pullRequest' | 'service'>[] = []
  for (const match of scanned.matchAll(URL_PATTERN)) {
    const link = classifySessionLink(trimMatchedUrl(match[0]))
    if (link) {
      links.push(link)
    }
  }
  return links
}

const linksByMessage = new WeakMap<
  NativeChatMessage,
  Pick<SessionLink, 'kind' | 'url' | 'pullRequest' | 'service'>[]
>()

/** Assistant prose and tool output only: a person's own pasted links are not the session's work. */
function linksInMessage(
  message: NativeChatMessage
): Pick<SessionLink, 'kind' | 'url' | 'pullRequest' | 'service'>[] {
  const cached = linksByMessage.get(message)
  if (cached) {
    return cached
  }
  const links: Pick<SessionLink, 'kind' | 'url' | 'pullRequest' | 'service'>[] = []
  if (message.role !== 'user') {
    for (const block of message.blocks) {
      if (block.type === 'text' && message.role === 'assistant') {
        links.push(...sessionLinksInText(block.text))
      } else if (block.type === 'tool-result') {
        links.push(...sessionLinksInText(block.output))
      }
    }
  }
  // Why: the assembler keeps unchanged messages by identity, so a long transcript is scanned once
  // and each streamed update only pays for the message that changed.
  linksByMessage.set(message, links)
  return links
}

/** Every session link in the transcript, deduped by normalized URL, newest first. */
export function extractSessionLinks(messages: readonly NativeChatMessage[]): SessionLink[] {
  const byKey = new Map<string, SessionLink>()
  messages.forEach((message, messageIndex) => {
    for (const link of linksInMessage(message)) {
      const key = normalizeLinkKey(link.url)
      byKey.delete(key)
      byKey.set(key, { ...link, key, messageIndex })
    }
  })
  return [...byKey.values()].toReversed()
}
