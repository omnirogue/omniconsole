import {
  WORKFLOW_FIND_MAX_ITEMS,
  WORKFLOW_FIND_MAX_ITEM_CHARS,
  type FindImportReceipt,
  type FindImportSkip,
  type WorkflowFindItem
} from './workflow-graph'
import { scanCsvRecords } from './workflow-find-scan-csv'

export const WORKFLOW_FIND_SCAN_MAX_BYTES = 1024 * 1024
export type FindScanMapping = { title?: string; detail?: string; url?: string }
/** Skipped is the same count as receipt.skipped.length; kept for existing callers. Merged is
 * always 0 here — dedupe only happens once the items reach the spec, which fills it in. */
export type FindScanResult = {
  items: WorkflowFindItem[]
  skipped: number
  receipt: FindImportReceipt
  note?: string
}
export type FindScanFormat = 'csv' | 'json'

const byteLength = (text: string) => new TextEncoder().encode(text).length

export function scanFormat(filename: string, source: string): FindScanFormat {
  if (/\.json$/i.test(filename)) {
    return 'json'
  }
  if (/\.csv$/i.test(filename)) {
    return 'csv'
  }
  return /^[\s﻿]*[[{]/.test(source) ? 'json' : 'csv'
}

function mappedFields(keys: string[], mapping: FindScanMapping) {
  const field = (name: keyof FindScanMapping, aliases: string[]) => {
    const explicit = mapping[name]
    if (explicit !== undefined && !keys.includes(explicit)) {
      throw new Error(`The ${name} field "${explicit}" was not found.`)
    }
    return explicit ?? keys.find((key) => aliases.includes(key.trim().toLowerCase()))
  }
  const title = field('title', ['title', 'name'])
  if (!title) {
    throw new Error('Choose a title field, or name it title or name.')
  }
  return {
    title,
    detail: field('detail', ['description', 'detail']),
    url: field('url', ['url', 'link'])
  }
}

/** A row with nothing in it (a blank CSV line, or a whitespace-only JSON string) is never a row. */
function isBlankRow(row: unknown): boolean {
  return row === null || (typeof row === 'string' && row.trim() === '')
}

/** Both the terminal and the app import exactly the same bounded options. */
export function parseFindScan(
  source: string,
  format: FindScanFormat = scanFormat('', source),
  mapping: FindScanMapping = {}
): FindScanResult {
  if (byteLength(source) > WORKFLOW_FIND_SCAN_MAX_BYTES) {
    throw new Error('The file is larger than 1 MB.')
  }
  source = source.replace(/^﻿/, '')
  if (!source.trim()) {
    throw new Error('The file is empty.')
  }
  let rows: unknown[]
  let keys: string[]
  if (format === 'json') {
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw new Error('The file is not valid JSON.')
    }
    if (!Array.isArray(value)) {
      throw new Error('The JSON file must contain an array.')
    }
    rows = value
    keys = [
      ...new Set(
        rows.flatMap((row) =>
          row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : []
        )
      )
    ]
  } else {
    const records = scanCsvRecords(source)
    const header = records.shift()
    if (!header || new Set(header).size !== header.length) {
      throw new Error('The CSV header is invalid or repeats a column.')
    }
    keys = header
    // An all-empty row (a blank CSV line, even in a single-column file) is dropped as blank
    // before it ever becomes {title: ''}: it must never count as an option, or against the cap.
    rows = records.map((row) =>
      row?.length === keys.length && row.some((value) => value.trim() !== '')
        ? Object.fromEntries(keys.map((key, i) => [key, row[i]]))
        : null
    )
  }
  if (!rows.length) {
    throw new Error('The file has no option rows.')
  }
  // A blank line between two halves of a list is never a 2,001st option: it never counts here.
  const countable = rows.filter((row) => !isBlankRow(row)).length
  if (countable > WORKFLOW_FIND_MAX_ITEMS) {
    throw new Error(`Import at most ${WORKFLOW_FIND_MAX_ITEMS} rows at a time.`)
  }
  const fields = keys.length || format === 'csv' ? mappedFields(keys, mapping) : undefined
  const items: WorkflowFindItem[] = []
  const skipped: FindImportSkip[] = []
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  rows.forEach((row, index) => {
    const line = index + 1
    if (typeof row === 'string') {
      const title = text(row)
      if (title && title.length <= WORKFLOW_FIND_MAX_ITEM_CHARS) {
        items.push(title)
      } else {
        skipped.push({ line, reason: title ? 'title too long' : 'no title' })
      }
      return
    }
    const record =
      row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {}
    const title = text(fields && record[fields.title])
    const detail = text(fields?.detail && record[fields.detail])
    const url = text(fields?.url && record[fields.url])
    if (!title) {
      skipped.push({ line, reason: 'no title' })
      return
    }
    if ([title, detail, url].some((value) => value.length > WORKFLOW_FIND_MAX_ITEM_CHARS)) {
      skipped.push({ line, reason: 'a field is too long' })
      return
    }
    items.push({ title, ...(detail ? { detail } : {}), ...(url ? { url } : {}) })
  })
  const result: FindScanResult = {
    items,
    skipped: skipped.length,
    // merged is 0 here: dedupe happens once these items reach the spec (splitFindItems), which
    // fills the real count in without discarding this receipt's read/skipped record.
    receipt: { read: rows.length, imported: items.length, skipped, merged: 0 }
  }
  checkRpcBudget(result)
  return result
}

/**
 * The desktop's runtime socket refuses a request frame over 1 MB; a file that fits on disk can
 * still grow past that once every row is re-encoded as JSON with field names and escaping. Never
 * silently rewrites an accepted row: an import that would not fit is refused, named, with what to
 * do about it, so the person chooses to shorten it rather than have it done to them unannounced.
 */
const SAFE_ITEMS_JSON_BYTES = 900_000
function checkRpcBudget(result: FindScanResult): void {
  const size = byteLength(JSON.stringify(result.items))
  if (size > SAFE_ITEMS_JSON_BYTES) {
    throw new Error(
      `This import is too large to send once encoded (${result.items.length} rows). ` +
        'Import fewer rows, or remove the description/link columns and try again.'
    )
  }
}
