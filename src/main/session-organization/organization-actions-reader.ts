/**
 * `omni session actions`: the trail in `<userData>/session-actions.jsonl` (and its rotated `.1`),
 * newest first. An organization change is one line however many phases it wrote: its latest.
 */

import { readFile } from 'node:fs/promises'
import {
  sessionActionActorKind,
  type SessionActionLine
} from '../../shared/session-organization-readers'

export type SessionActionsQuery = {
  since: number
  actors?: readonly string[]
  kinds?: readonly string[]
  limit: number
}

function isLine(value: unknown): value is SessionActionLine {
  const line = value as Partial<SessionActionLine> | null
  return Boolean(
    line &&
    typeof line.ts === 'string' &&
    typeof line.action === 'string' &&
    typeof line.summary === 'string' &&
    line.actor !== undefined
  )
}

async function readLines(path: string): Promise<SessionActionLine[]> {
  const lines: SessionActionLine[] = []
  for (const file of [`${path}.1`, path]) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) {
        continue
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isLine(parsed)) {
          lines.push(parsed)
        }
      } catch {
        // Why: a torn last line from a crash must not hide every other action.
      }
    }
  }
  return lines
}

function matchesKind(line: SessionActionLine, kinds: readonly string[]): boolean {
  return (
    kinds.includes(line.action) || (!!line.organization && kinds.includes(line.organization.kind))
  )
}

export async function readSessionActions(
  path: string,
  query: SessionActionsQuery
): Promise<SessionActionLine[]> {
  const lines = await readLines(path)
  const latest = new Map<string, SessionActionLine>()
  const kept: SessionActionLine[] = []
  for (const line of lines) {
    if (line.opId) {
      latest.set(line.opId, line)
    } else {
      kept.push(line)
    }
  }
  const since = new Date(query.since).toISOString()
  return [...kept, ...latest.values()]
    .filter(
      (line) =>
        line.ts >= since &&
        (!query.actors?.length || query.actors.includes(sessionActionActorKind(line))) &&
        (!query.kinds?.length || matchesKind(line, query.kinds))
    )
    .sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0))
    .slice(0, query.limit)
}
