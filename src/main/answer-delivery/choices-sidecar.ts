/**
 * The `choices` sidecar a review page's publisher wrote next to its page (`<day>/<time>-<name>.json`
 * under the configured choices folder): the session to notify, the folder it ran in, and the
 * notifier's receipts. A receipt counts only for the exact decision id it names.
 *
 * Bounded: the share record's own sidecar is read first; otherwise at most `maxFiles` sidecars of
 * at most `maxBytes` each, from the newest `maxDays` day folders.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const CHOICES_MAX_DAYS = 7
export const CHOICES_MAX_FILES = 150
export const CHOICES_MAX_BYTES = 256 * 1024

export type ChoicesLookupLimits = { maxDays: number; maxFiles: number; maxBytes: number }

const DEFAULT_LIMITS: ChoicesLookupLimits = {
  maxDays: CHOICES_MAX_DAYS,
  maxFiles: CHOICES_MAX_FILES,
  maxBytes: CHOICES_MAX_BYTES
}

export type ChoicesSidecar = {
  slug: string
  cwd: string | null
  /** `<host>:<session id>` (or a bare session id) of the session that asked. */
  notify: string | null
  /** `<status>|<decision id>|<revision>|...` the notifier handed to that session, and when. */
  delivered: { key: string; at: string } | null
  /** The key that session read back, and when. */
  read: { key: string; at: string } | null
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export function parseChoicesSidecar(raw: string, slug: string): ChoicesSidecar | null {
  let parsed: Record<string, unknown>
  try {
    parsed = asRecord(JSON.parse(raw))
  } catch {
    return null
  }
  if (parsed.slug !== slug && parsed.id !== slug) {
    return null
  }
  const state = asRecord(parsed.notifyState)
  const keyAt = (key: unknown, at: unknown) => {
    const k = text(key)
    const a = text(at)
    return k && a ? { key: k, at: a } : null
  }
  return {
    slug,
    cwd: text(parsed.cwd),
    notify: text(parsed.notify) ?? text(state.address),
    delivered: keyAt(state.decision, state.deliveredAt),
    read: keyAt(state.readKey, state.readAt)
  }
}

async function readSidecar(
  path: string,
  slug: string,
  limits: ChoicesLookupLimits
): Promise<ChoicesSidecar | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > limits.maxBytes) {
    return null
  }
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.includes(slug) ? parseChoicesSidecar(raw, slug) : null
}

/** Sidecar paths to try, newest first, at most `maxFiles`. */
export async function choicesSidecarPaths(
  choicesDir: string,
  limits: ChoicesLookupLimits = DEFAULT_LIMITS
): Promise<string[]> {
  const days = (await readdir(choicesDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limits.maxDays)
  const paths: string[] = []
  for (const day of days) {
    const files = (await readdir(join(choicesDir, day)).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a))
    for (const file of files) {
      if (paths.length >= limits.maxFiles) {
        return paths
      }
      paths.push(join(choicesDir, day, file))
    }
  }
  return paths
}

/** The sidecar for a page: next to its share record's page first, then a bounded newest-first scan. */
export async function findChoicesSidecar(
  slug: string,
  choicesDir: string,
  pagePath?: string,
  limits: ChoicesLookupLimits = DEFAULT_LIMITS
): Promise<ChoicesSidecar | null> {
  const hinted = pagePath?.endsWith('.html') ? pagePath.replace(/\.html$/, '.json') : null
  if (hinted) {
    const found = await readSidecar(hinted, slug, limits)
    if (found) {
      return found
    }
  }
  for (const path of await choicesSidecarPaths(choicesDir, limits)) {
    if (path === hinted) {
      continue
    }
    const found = await readSidecar(path, slug, limits)
    if (found) {
      return found
    }
  }
  return null
}

const decisionIdOf = (key: string): string => key.split('|')[1] ?? ''

/**
 * Evidence that the notifier delivered or the session read this exact decision; null otherwise.
 * A receipt for another decision on the same page (an earlier Request changes) never counts.
 */
export function choicesDecisionReceipt(
  sidecar: ChoicesSidecar | null,
  decisionId: unknown
): string | null {
  const id =
    typeof decisionId === 'number' || typeof decisionId === 'string'
      ? String(decisionId).trim()
      : ''
  if (!sidecar || !id) {
    return null
  }
  if (sidecar.read && decisionIdOf(sidecar.read.key) === id) {
    return `the asking session read decision ${id} at ${sidecar.read.at} (choices receipt)`
  }
  if (sidecar.delivered && decisionIdOf(sidecar.delivered.key) === id) {
    return `the choices notifier delivered decision ${id} at ${sidecar.delivered.at}`
  }
  return null
}

const hostKey = (host: string): string =>
  (host.toLowerCase().split('.')[0] ?? '').replace(/[^a-z0-9]/g, '')

/** The asking session a sidecar names, and whether it names this computer (or no computer). */
export function choicesNotifySession(
  sidecar: ChoicesSidecar,
  localHost: string
): { sessionId: string; thisHost: boolean } | null {
  if (!sidecar.notify) {
    return null
  }
  const colon = sidecar.notify.lastIndexOf(':')
  const host = colon === -1 ? '' : sidecar.notify.slice(0, colon)
  const sessionId = sidecar.notify.slice(colon + 1).trim()
  if (!/^[A-Za-z0-9-]{8,}$/.test(sessionId)) {
    return null
  }
  return { sessionId, thisHost: !host || host === 'local' || hostKey(host) === hostKey(localHost) }
}

/** `findChoicesSidecar` with results kept for `ttlMs`, so each pass does not rescan per delivery. */
export function cachedChoicesSidecars(
  choicesDir: string,
  ttlMs = 30_000,
  now: () => number = Date.now,
  limits: ChoicesLookupLimits = DEFAULT_LIMITS
) {
  const cache = new Map<string, { at: number; sidecar: ChoicesSidecar | null }>()
  return async (slug: string, pagePath?: string): Promise<ChoicesSidecar | null> => {
    for (const [key, entry] of cache) {
      if (now() - entry.at >= ttlMs) {
        cache.delete(key)
      }
    }
    const cached = cache.get(slug)
    if (cached) {
      return cached.sidecar
    }
    const sidecar = await findChoicesSidecar(slug, choicesDir, pagePath, limits)
    cache.set(slug, { at: now(), sidecar })
    return sidecar
  }
}
