import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { JevCallRow, JevOutcomeRow } from '../../shared/jev-ledger'
import { JEV_CALLS_FILE, JEV_LEDGER_MAX_ROW_BYTES, JEV_OUTCOMES_FILE } from './jev-ledger'

const ROTATED = /^calls-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(?:-\d+)?\.jsonl$/
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024
const NEWLINE = 0x0a

/** Only the ledger's own files: a client-supplied export cursor never names another path. */
export function isLedgerSegment(name: string): boolean {
  return name === JEV_CALLS_FILE || name === JEV_OUTCOMES_FILE || ROTATED.test(name)
}

/** Rotated call files, oldest first; their names carry the UTC time they were closed. */
export async function rotatedCallSegments(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [] as string[]
    }
    throw error
  })
  return names.filter((name) => ROTATED.test(name)).toSorted()
}

/** When a rotated file was closed: none of its rows started later. */
export function segmentClosedAt(name: string): number | null {
  const match = ROTATED.exec(name)
  if (!match) {
    return null
  }
  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(Number)
  return Date.UTC(year!, month! - 1, day, hour, minute, second, ms)
}

/** A segment's bytes from `offset` (at most `limit`), or empty when it does not exist yet. */
export async function readSegment(
  directory: string,
  name: string,
  offset = 0,
  limit = Number.POSITIVE_INFINITY
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Buffer.alloc(0)
    }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size > MAX_SEGMENT_BYTES) {
      throw new Error(`JEV ledger file ${name} exceeds its size limit.`)
    }
    const length = Math.max(0, Math.min(size - offset, limit))
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Complete lines only: a line still being appended has no newline yet. */
export function completeLines(buffer: Buffer): { line: string; bytes: number }[] {
  const lines: { line: string; bytes: number }[] = []
  let start = 0
  for (let end = buffer.indexOf(NEWLINE); end !== -1; end = buffer.indexOf(NEWLINE, start)) {
    lines.push({ line: buffer.toString('utf8', start, end), bytes: end + 1 - start })
    start = end + 1
  }
  return lines
}

export function parseLedgerLine<T>(line: string): T | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null
  } catch {
    return null
  }
}

/** Identifies a calls file across a rotation that renames it between export pages. */
export async function segmentHead(directory: string, name: string): Promise<string | null> {
  const [first] = completeLines(await readSegment(directory, name, 0, JEV_LEDGER_MAX_ROW_BYTES + 1))
  return first ? createHash('sha256').update(first.line).digest('hex') : null
}

export async function readCallRows(directory: string, name: string) {
  const rows: JevCallRow[] = []
  let malformed = 0
  for (const { line } of completeLines(await readSegment(directory, name))) {
    const row = parseLedgerLine<JevCallRow>(line)
    if (row && typeof row.record_key === 'string' && typeof row.observed_at === 'string') {
      rows.push(row)
    } else if (line.trim()) {
      malformed++
    }
  }
  return { rows, malformed }
}

export async function readOutcomeRows(directory: string): Promise<JevOutcomeRow[]> {
  return completeLines(await readSegment(directory, JEV_OUTCOMES_FILE)).flatMap(({ line }) => {
    const row = parseLedgerLine<JevOutcomeRow>(line)
    return row && typeof row.record_key === 'string' ? [row] : []
  })
}

/** Searches newest first; the serialized row always spells its key the same way. */
export async function ledgerHasRecord(directory: string, recordKey: string): Promise<boolean> {
  const needle = `"record_key":${JSON.stringify(recordKey)},`
  for (const name of [JEV_CALLS_FILE, ...(await rotatedCallSegments(directory)).toReversed()]) {
    if ((await readSegment(directory, name)).includes(needle)) {
      return true
    }
  }
  return false
}
