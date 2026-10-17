import type * as SmolToml from 'smol-toml' with { 'resolution-mode': 'import' }
import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'

// Why: smol-toml ships CJS at runtime but ESM-only declarations (see omni-console-mcp-toml.ts).
const { parse } = require('smol-toml') as typeof SmolToml

// Why: a stopped WSL distro parks UNC reads; an unanswered read is treated as no evidence.
const READ_TIMEOUT_MS = 5_000

function kimiHomeFile(home: string, ...segments: string[]): string {
  return parseWslUncPath(home) ? pathWin32.join(home, ...segments) : join(home, ...segments)
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, { encoding: 'utf-8', signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** Kimi stores `expires_at` in epoch seconds; a millisecond value is read as such. */
function isFutureExpiry(expiresAt: unknown): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false
  }
  return (expiresAt > 1e12 ? expiresAt : expiresAt * 1000) > Date.now()
}

async function hasOAuthLogin(home: string): Promise<boolean> {
  const raw = await readText(kimiHomeFile(home, 'credentials', 'kimi-code.json'))
  if (raw === null) {
    return false
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') {
      return false
    }
    const record = value as Record<string, unknown>
    if (nonEmptyString(record.refresh_token)) {
      return true
    }
    // Why: without a refresh token Kimi cannot renew an access token, so it signs in only while fresh.
    return nonEmptyString(record.access_token) && isFutureExpiry(record.expires_at)
  } catch {
    return false
  }
}

async function hasApiKeyProvider(home: string): Promise<boolean> {
  const raw = await readText(kimiHomeFile(home, 'config.toml'))
  if (raw === null) {
    return false
  }
  try {
    const providers = parse(raw).providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      return false
    }
    return Object.values(providers).some(
      (provider) =>
        Boolean(provider) &&
        typeof provider === 'object' &&
        !Array.isArray(provider) &&
        nonEmptyString((provider as Record<string, unknown>).api_key)
    )
  } catch {
    return false
  }
}

/**
 * Whether the Kimi CLI at `homePath` has a usable login: a stored OAuth token or an
 * API-key provider. Read-only; never refreshes tokens and never surfaces their values.
 */
export async function readKimiSignIn(homePath: string): Promise<boolean> {
  const [oauth, apiKey] = await Promise.all([hasOAuthLogin(homePath), hasApiKeyProvider(homePath)])
  return oauth || apiKey
}
