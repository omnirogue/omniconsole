/**
 * The last resort for a review page no share record, OmniOS binding or sidecar ties to a session:
 * the Claude transcript whose publish call returned the page. Only a publish tool's own result
 * naming the slug counts; a session that merely read, waited on or discussed the page does not.
 *
 * Bounded per lookup: at most `maxStats` transcripts are stat'ed (project folders newest first),
 * only those touched within `maxAgeMs`, the newest `maxFiles` of them are read, each only its last
 * `tailBytes`. Results, found or not, are kept for `cacheMs` so a held delivery does not rescan
 * every pass.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readTranscriptTail } from '../work-delivery/work-delivery-transcript-receipt'

export type PublisherScanLimits = {
  maxStats: number
  maxFiles: number
  tailBytes: number
  maxAgeMs: number
  cacheMs: number
}

export const PUBLISHER_SCAN_LIMITS: PublisherScanLimits = {
  maxStats: 2000,
  maxFiles: 40,
  tailBytes: 1024 * 1024,
  maxAgeMs: 14 * 24 * 60 * 60_000,
  cacheMs: 10 * 60_000
}

export type PublishingTranscript = { path: string; sessionId: string }

const PUBLISH_TOOL = /(^|__)artifact_(publish|ask)$/
const PUBLISH_COMMAND = /\b(work-decision|choices)\s+ask\b|\bartifacts?\s+(share|publish)\b/

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

function contentParts(line: string): Record<string, unknown>[] {
  try {
    const content = asRecord(asRecord(JSON.parse(line))?.message)?.content
    return Array.isArray(content)
      ? content.map(asRecord).filter((part): part is Record<string, unknown> => part !== null)
      : []
  } catch {
    return []
  }
}

function isPublishCall(part: Record<string, unknown>): boolean {
  if (part.type !== 'tool_use' || typeof part.id !== 'string') {
    return false
  }
  const name = typeof part.name === 'string' ? part.name : ''
  const command = asRecord(part.input)?.command
  return PUBLISH_TOOL.test(name) || (typeof command === 'string' && PUBLISH_COMMAND.test(command))
}

/** True when a publish call in this transcript text returned the page `slug`. */
export function transcriptPublishedSlug(content: string, slug: string): boolean {
  const publishCalls = new Set<string>()
  for (const line of content.split('\n')) {
    if (!line.includes('tool_')) {
      continue
    }
    for (const part of contentParts(line)) {
      if (isPublishCall(part)) {
        publishCalls.add(part.id as string)
      } else if (
        part.type === 'tool_result' &&
        typeof part.tool_use_id === 'string' &&
        publishCalls.has(part.tool_use_id) &&
        JSON.stringify(part.content ?? '').includes(slug)
      ) {
        return true
      }
    }
  }
  return false
}

async function recentTranscripts(
  roots: readonly string[],
  limits: PublisherScanLimits,
  now: number
): Promise<string[]> {
  const projects: { path: string; mtimeMs: number }[] = []
  // Why one budget for folders and files: every stat counts toward the bound.
  let stats = 0
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && stats < limits.maxStats) {
        stats += 1
        const info = await stat(join(root, entry.name)).catch(() => null)
        projects.push({ path: join(root, entry.name), mtimeMs: info?.mtimeMs ?? 0 })
      }
    }
  }
  projects.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const files: { path: string; mtimeMs: number }[] = []
  for (const project of projects) {
    for (const name of await readdir(project.path).catch(() => [])) {
      if (!name.endsWith('.jsonl')) {
        continue
      }
      if (stats >= limits.maxStats) {
        return newest(files, limits)
      }
      stats += 1
      const info = await stat(join(project.path, name)).catch(() => null)
      if (info?.isFile() && now - info.mtimeMs <= limits.maxAgeMs) {
        files.push({ path: join(project.path, name), mtimeMs: info.mtimeMs })
      }
    }
  }
  return newest(files, limits)
}

const newest = (files: { path: string; mtimeMs: number }[], limits: PublisherScanLimits) =>
  files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limits.maxFiles)
    .map((file) => file.path)

/** A cached, bounded finder of a page's publishing transcript under Claude `projects` roots. */
export function publisherScanner(
  roots: () => Promise<readonly string[]>,
  limits: PublisherScanLimits = PUBLISHER_SCAN_LIMITS,
  now: () => number = Date.now
) {
  const cache = new Map<string, { at: number; found: PublishingTranscript | null }>()
  return async (slug: string): Promise<PublishingTranscript | null> => {
    for (const [key, entry] of cache) {
      if (now() - entry.at >= limits.cacheMs) {
        cache.delete(key)
      }
    }
    const cached = cache.get(slug)
    if (cached) {
      return cached.found
    }
    let found: PublishingTranscript | null = null
    for (const path of await recentTranscripts(await roots(), limits, now())) {
      const content = await readTranscriptTail(path, limits.tailBytes).catch(() => '')
      if (content.includes(slug) && transcriptPublishedSlug(content, slug)) {
        found = { path, sessionId: basename(path, '.jsonl') }
        break
      }
    }
    cache.set(slug, { at: now(), found })
    return found
  }
}
