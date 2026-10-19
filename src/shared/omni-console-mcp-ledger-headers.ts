import {
  OMNI_LEDGER_ATTEMPT_HEADER,
  OMNI_LEDGER_ATTEMPT_ID_ENV,
  OMNI_LEDGER_SESSION_HEADER,
  OMNI_LEDGER_SESSION_ID_ENV
} from './session-ledger-env'

export const OMNI_CONSOLE_MCP_NAME = 'omni-console'
export const OMNI_CONSOLE_MCP_URL = 'https://console.omnisi.ai/mcp'
/** The team's OmniSI Cloud connector (Pages, Decisions, Shared Tools); WorkOS OAuth. */
export const OMNISI_MCP_NAME = 'omnisi'
export const OMNISI_MCP_URL = 'https://app.omnisi.ai/mcp'
/** The OmniRogue Creative & Credits MCP endpoint (`https://api.omnirogue.com/mcp`). */
export const OMNIROGUE_MCP_NAME = 'omnirogue'
export const OMNIROGUE_MCP_URL = 'https://api.omnirogue.com/mcp'

export const OMNICONSOLE_DEFAULT_MCP_ENDPOINTS = [
  { name: OMNI_CONSOLE_MCP_NAME, url: OMNI_CONSOLE_MCP_URL, label: 'OmniConsole MCP' },
  { name: OMNISI_MCP_NAME, url: OMNISI_MCP_URL, label: 'OmniSI Shared Tools MCP' }
] as const

export const OMNIROGUE_UNIFIED_MCP_ENDPOINTS = [
  {
    name: OMNISI_MCP_NAME,
    url: OMNISI_MCP_URL,
    label: 'OmniRogue & OmniSI Unified MCP'
  },
  {
    name: OMNIROGUE_MCP_NAME,
    url: OMNIROGUE_MCP_URL,
    label: 'OmniRogue Creative & Credits MCP'
  },
  {
    name: OMNI_CONSOLE_MCP_NAME,
    url: OMNI_CONSOLE_MCP_URL,
    label: 'OmniConsole Estate MCP'
  }
] as const

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export type OmniConsoleMcpConfigStyle = 'claude' | 'gemini' | 'codex' | 'grok'

/**
 * The session-ledger headers the connector reads on every `/mcp` call, written as each
 * CLI's own env reference so the SHARED config carries the per-pane ids the IDE stamps
 * into the process env. Outside the IDE the reference expands empty and the console
 * ignores it. Codex names the env var (`env_http_headers`); the others expand `${VAR}`.
 */
export function omniConsoleMcpLedgerHeaders(
  style: OmniConsoleMcpConfigStyle
): Record<string, string> {
  const reference = (name: string): string =>
    style === 'codex' ? name : style === 'gemini' ? `\${${name}}` : `\${${name}:-}`
  return {
    [OMNI_LEDGER_SESSION_HEADER]: reference(OMNI_LEDGER_SESSION_ID_ENV),
    [OMNI_LEDGER_ATTEMPT_HEADER]: reference(OMNI_LEDGER_ATTEMPT_ID_ENV)
  }
}

/** The key each CLI uses for HTTP headers on a streamable-HTTP server. */
export function omniConsoleMcpHeadersKey(
  style: OmniConsoleMcpConfigStyle
): 'headers' | 'env_http_headers' {
  return style === 'codex' ? 'env_http_headers' : 'headers'
}

/** Where the app ships the Claude `headersHelper`: `<resources>/mcp/<file>`. */
export const OMNI_CONSOLE_MCP_HEADERS_HELPER_DIR = 'mcp'
export const OMNI_CONSOLE_MCP_HEADERS_HELPER_FILE = 'omni-console-mcp-headers.sh'
const HEADERS_HELPER_SUFFIX = `/${OMNI_CONSOLE_MCP_HEADERS_HELPER_DIR}/${OMNI_CONSOLE_MCP_HEADERS_HELPER_FILE}`
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./+@%,:=-]+$/

/**
 * The `headersHelper` command for an absolute helper path. Claude Code hands the string to a
 * shell, so a path with spaces (e.g. under "Application Support") is single-quoted.
 */
export function omniConsoleMcpHeadersHelperCommand(absolutePath: string): string {
  return SHELL_SAFE_PATH.test(absolutePath)
    ? absolutePath
    : `'${absolutePath.replaceAll("'", `'\\''`)}'`
}

/**
 * True only when a `headersHelper` value is exactly this app's helper command (any install
 * location): the absolute helper path, quoted or not, and nothing else. A value that wraps or
 * extends it (`/usr/bin/env X=y /…/mcp/omni-console-mcp-headers.sh`, extra arguments, `;`) is
 * the user's own command and must never be rewritten.
 */
export function isOmniConsoleMcpHeadersHelperCommand(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const path =
    value.length > 1 && value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1).replaceAll(`'\\''`, "'")
      : value
  // Why the round trip: only the exact string this app would write for `path` counts, so no
  // unquoted whitespace, shell token or partial quoting can slip through as "ours".
  return (
    path.startsWith('/') &&
    path.endsWith(HEADERS_HELPER_SUFFIX) &&
    omniConsoleMcpHeadersHelperCommand(path) === value
  )
}

export type OmniConsoleMcpEntryOptions = {
  /**
   * `headersHelper` command for the Claude style. Set only for local spawns whose host can run
   * the app-owned helper; relay/remote, WSL and Windows spawns leave it unset and keep `headers`.
   */
  claudeHeadersHelper?: string
}

/**
 * Why the helper shape: Claude Code keys a saved MCP login on
 * `name|sha256({type,url,headers})[:16]` with `headers` expanded, so the per-pane ledger ids in
 * `headers` gave every pane a new login slot and no login held. `headersHelper` output is not
 * part of that key, so every profile converges on one key (`omni-console|a1f900b4204085b4`) and
 * one `claude mcp login omni-console` holds. The slots the old shape left in each profile's
 * Keychain item are stale and ignored by Claude Code; they are deliberately not swept.
 */
export function omniConsoleMcpDefaultEntry(
  style: 'claude' | 'gemini' | 'muse',
  options: OmniConsoleMcpEntryOptions = {}
): Record<string, unknown> {
  if (style === 'gemini') {
    return { httpUrl: OMNI_CONSOLE_MCP_URL, headers: omniConsoleMcpLedgerHeaders('gemini') }
  }
  if (style === 'muse') {
    // Why no ledger headers: Muse expands no `${VAR}` and has no headers helper, so a reference
    // would be sent verbatim. `optional` keeps Muse starting when the console is unreachable.
    return { type: 'streamable-http', url: OMNI_CONSOLE_MCP_URL, mode: 'optional' }
  }
  return options.claudeHeadersHelper
    ? { type: 'http', url: OMNI_CONSOLE_MCP_URL, headersHelper: options.claudeHeadersHelper }
    : { type: 'http', url: OMNI_CONSOLE_MCP_URL, headers: omniConsoleMcpLedgerHeaders('claude') }
}

const MANAGED_ENTRY_KEYS = new Set([
  'type',
  'url',
  'httpUrl',
  'headers',
  'env_http_headers',
  'headersHelper',
  'enabled'
])

/**
 * True for an entry this app wrote: our URL, no command, and either at most our own ledger
 * headers (legacy shape) or our helper and no headers (current Claude shape). A user's override
 * (other keys, other header names such as `X-Omni-Client`, a foreign helper, another URL) is not ours.
 */
export function isManagedOmniConsoleMcpEntry(entry: unknown): boolean {
  return isManagedEntryFor(entry, OMNI_CONSOLE_MCP_URL)
}

/** The same managed-shape rule as {@link isManagedOmniConsoleMcpEntry}, for the OmniSI endpoint. */
export function isManagedOmniSiMcpEntry(entry: unknown): boolean {
  return isManagedEntryFor(entry, OMNISI_MCP_URL)
}

/** The same managed-shape rule as {@link isManagedOmniConsoleMcpEntry}, for the OmniRogue endpoint. */
export function isManagedOmniRogueMcpEntry(entry: unknown): boolean {
  return isManagedEntryFor(entry, OMNIROGUE_MCP_URL)
}

export function omniRogueUnifiedMcpDefaultEntry(
  url: string,
  style: 'claude' | 'gemini' | 'muse',
  options: OmniConsoleMcpEntryOptions = {}
): Record<string, unknown> {
  if (style === 'gemini') {
    return { httpUrl: url, headers: omniConsoleMcpLedgerHeaders('gemini') }
  }
  if (style === 'muse') {
    return { type: 'streamable-http', url, mode: 'optional' }
  }
  return options.claudeHeadersHelper
    ? { type: 'http', url, headersHelper: options.claudeHeadersHelper }
    : { type: 'http', url, headers: omniConsoleMcpLedgerHeaders('claude') }
}

export function isManagedOmniMcpEntry(entry: unknown): boolean {
  return (
    isManagedOmniConsoleMcpEntry(entry) ||
    isManagedOmniSiMcpEntry(entry) ||
    isManagedOmniRogueMcpEntry(entry)
  )
}

function isManagedEntryFor(entry: unknown, url: string): boolean {
  const server = object(entry)
  if (!server || (server.httpUrl ?? server.url) !== url) {
    return false
  }
  if (Object.keys(server).some((key) => !MANAGED_ENTRY_KEYS.has(key))) {
    return false
  }
  if (server.type !== undefined && server.type !== 'http') {
    return false
  }
  if (server.enabled !== undefined && server.enabled !== true) {
    return false
  }
  if (server.headersHelper !== undefined) {
    return (
      isOmniConsoleMcpHeadersHelperCommand(server.headersHelper) &&
      server.headers === undefined &&
      server.env_http_headers === undefined &&
      server.httpUrl === undefined
    )
  }
  for (const key of ['headers', 'env_http_headers'] as const) {
    const headers = server[key]
    if (headers === undefined) {
      continue
    }
    const record = object(headers)
    if (!record) {
      return false
    }
    const known = new Set([OMNI_LEDGER_SESSION_HEADER, OMNI_LEDGER_ATTEMPT_HEADER])
    if (Object.keys(record).some((name) => !known.has(name))) {
      return false
    }
  }
  return true
}

/**
 * A managed `headers` entry that predates the ledger headers. A helper-shape entry is never
 * "missing" them: the helper supplies them, and adding `headers` would move its login key.
 */
export function omniConsoleMcpEntryNeedsLedgerHeaders(
  entry: unknown,
  style: OmniConsoleMcpConfigStyle
): boolean {
  if (!isManagedOmniConsoleMcpEntry(entry)) {
    return false
  }
  const server = entry as Record<string, unknown>
  if (server.headersHelper !== undefined) {
    return false
  }
  const headers = object(server[omniConsoleMcpHeadersKey(style)])
  return (
    !headers ||
    !Object.hasOwn(headers, OMNI_LEDGER_SESSION_HEADER) ||
    !Object.hasOwn(headers, OMNI_LEDGER_ATTEMPT_HEADER)
  )
}

/**
 * The entry the writer should put in place of a managed `entry`, or null when it is already the
 * current shape (or not ours). With a helper, any other managed shape — endpoint-only, ledger
 * `headers` as `${VAR:-}` templates or literal ids, or our helper at an older install path — is
 * rewritten to the helper shape. Without one (relay/remote, WSL, Gemini) the legacy rule holds:
 * only a header-less entry gains the ledger headers, and a helper entry is left as it is.
 */
export function upgradeManagedOmniConsoleMcpEntry(
  entry: unknown,
  style: 'claude' | 'gemini',
  options: OmniConsoleMcpEntryOptions = {}
): Record<string, unknown> | null {
  if (!isManagedOmniConsoleMcpEntry(entry)) {
    return null
  }
  const server = entry as Record<string, unknown>
  if (style === 'claude' && options.claudeHeadersHelper) {
    const current = omniConsoleMcpDefaultEntry('claude', options)
    const keys = Object.keys(server)
    const isCurrent =
      keys.length === Object.keys(current).length &&
      keys.every((key) => server[key] === current[key])
    return isCurrent ? null : current
  }
  if (!omniConsoleMcpEntryNeedsLedgerHeaders(server, style)) {
    return null
  }
  return {
    ...server,
    headers: { ...object(server.headers), ...omniConsoleMcpLedgerHeaders(style) }
  }
}
