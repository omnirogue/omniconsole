import {
  WORKFLOW_FIND_MAX_ITEM_CHARS,
  type FindImportReceipt,
  type FindImportSkip,
  type WorkflowFindItem
} from './workflow-graph'
import { cleanText } from './workflow-spec-coercion'

export type { FindImportReceipt, FindImportSkip }

/** Two options only merge when the whole visible text matches, not just the title. */
function dedupeKey(title: string, detail: string, url: string): string {
  return `${title.toLowerCase()}\u0000${detail.toLowerCase()}\u0000${url.toLowerCase()}`
}

/**
 * Legacy strings keep their existing trimming and truncation. Two entries only merge as the same
 * option when their title, detail and url all match case-insensitively — the same title with a
 * different detail (two vendors both called "Acme") is never silently dropped. Every row read is
 * accounted for: kept, merged into an earlier one, or skipped with why (both counted for the
 * immutable receipt, and named so a person can see exactly what happened to their list).
 */
function normalizeFindItems(raw: unknown): {
  items: WorkflowFindItem[]
  merged: number
  receipt: FindImportReceipt
} {
  const rows = Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  let merged = 0
  const skipped: FindImportSkip[] = []
  const items = rows.flatMap((entry, index): WorkflowFindItem[] => {
    const structured = entry && typeof entry === 'object' && !Array.isArray(entry)
    const title = cleanText(structured ? entry.title : entry, WORKFLOW_FIND_MAX_ITEM_CHARS)
    const detail =
      structured && typeof entry.detail === 'string'
        ? cleanText(entry.detail, WORKFLOW_FIND_MAX_ITEM_CHARS)
        : ''
    const url =
      structured && typeof entry.url === 'string'
        ? cleanText(entry.url, WORKFLOW_FIND_MAX_ITEM_CHARS)
        : ''
    if (!title) {
      skipped.push({ line: index + 1, reason: 'no title' })
      return []
    }
    const key = dedupeKey(title, detail, url)
    if (seen.has(key)) {
      merged++
      return []
    }
    seen.add(key)
    return [structured ? { title, ...(detail ? { detail } : {}), ...(url ? { url } : {}) } : title]
  })
  return {
    items,
    merged,
    receipt: { read: rows.length, imported: items.length, skipped, merged }
  }
}

/** Truncates a title so `${title}${suffix}` still fits the legacy per-item character limit. */
function reserveSuffixRoom(title: string, suffix: string): string {
  const room = WORKFLOW_FIND_MAX_ITEM_CHARS - suffix.length
  return title.length <= room ? title : title.slice(0, Math.max(0, room))
}

/**
 * Makes same-titled-but-different options distinct in the saved title itself ("Acme" / "Acme
 * (2)"), so an older build's own title-only dedupe (which knows nothing of itemDetails) can never
 * silently collapse two real options into one just because they share a title. The number chosen
 * is the next one free against BOTH the real titles already in the list and every disambiguated
 * name generated so far (a real "Acme (2)" already in the list is never reused or collided with),
 * and the suffix always has room within the legacy per-item character limit, even for a title
 * already at that limit.
 */
function disambiguateTitles(items: WorkflowFindItem[]): WorkflowFindItem[] {
  const titleOf = (entry: WorkflowFindItem) => (typeof entry === 'string' ? entry : entry.title)
  const taken = new Set(items.map((entry) => titleOf(entry).toLowerCase()))
  const occurrences = new Map<string, number>()
  return items.map((entry) => {
    const title = titleOf(entry)
    const key = title.toLowerCase()
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    if (occurrence === 1) {
      return entry
    }
    let n = 2
    let distinct = title
    let distinctKey = key
    for (;;) {
      const suffix = ` (${n})`
      distinct = `${reserveSuffixRoom(title, suffix)}${suffix}`
      distinctKey = distinct.toLowerCase()
      if (!taken.has(distinctKey)) {
        break
      }
      n++
    }
    taken.add(distinctKey)
    return typeof entry === 'string' ? distinct : { ...entry, title: distinct }
  })
}

export type FindItemDetail = { detail?: string; url?: string }

/**
 * The saved shape a person's own list takes: plain titles (`find.items`, exactly the shape an
 * older build already understands), plus optional detail/url for the same index (`itemDetails`,
 * absent unless at least one entry actually has one). An older reader ignores a field it does not
 * know and still sees every title, each one distinct; it never sees an object where a string used
 * to be, and never silently merges two different options that happen to share a title.
 */
export function splitFindItems(raw: unknown): {
  items: string[]
  itemDetails?: FindItemDetail[]
  merged: number
  receipt: FindImportReceipt
} {
  const { items: deduped, merged, receipt } = normalizeFindItems(raw)
  const structured = disambiguateTitles(deduped)
  const items = structured.map((entry) => (typeof entry === 'string' ? entry : entry.title))
  const hasDetail = structured.some(
    (entry) => typeof entry !== 'string' && (entry.detail || entry.url)
  )
  return {
    items,
    ...(hasDetail
      ? {
          itemDetails: structured.map((entry): FindItemDetail => {
            if (typeof entry === 'string') {
              return {}
            }
            return {
              ...(entry.detail ? { detail: entry.detail } : {}),
              ...(entry.url ? { url: entry.url } : {})
            }
          })
        }
      : {}),
    merged,
    receipt
  }
}

/**
 * Reads a saved spec's list back into the same split shape, from either the canonical saved form
 * (`items: string[]` + aligned `itemDetails`) or a structured `WorkflowFindItem[]` (a request
 * built the request-level way, or an older in-flight save from before this split existed).
 */
export function readFindItems(
  rawItems: unknown,
  rawItemDetails: unknown
): {
  items: string[]
  itemDetails?: FindItemDetail[]
  merged: number
  receipt: FindImportReceipt
} {
  if (!Array.isArray(rawItems)) {
    return { items: [], merged: 0, receipt: { read: 0, imported: 0, skipped: [], merged: 0 } }
  }
  if (rawItems.every((entry) => typeof entry === 'string') && Array.isArray(rawItemDetails)) {
    const merged: WorkflowFindItem[] = rawItems.map((title, index) => {
      const extra = rawItemDetails[index]
      if (extra && typeof extra === 'object') {
        const record = extra as Record<string, unknown>
        return {
          title,
          ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
          ...(typeof record.url === 'string' ? { url: record.url } : {})
        }
      }
      return title
    })
    return splitFindItems(merged)
  }
  return splitFindItems(rawItems)
}
