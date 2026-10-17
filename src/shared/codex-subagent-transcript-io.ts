import { StringDecoder } from 'node:string_decoder'
import { open, opendir, stat, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PrioritySemaphore } from './priority-semaphore'

const transcriptReads = new PrioritySemaphore(4)
const TRANSCRIPT_READ_MAX_BYTES = 256 * 1024
const TRANSCRIPT_LINE_MAX_BYTES = 256 * 1024
const TRANSCRIPT_DIRECTORY_MAX_ENTRIES = 4096
const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/
export type TranscriptReadBudget = { remaining: number }
export type JsonlCursor = {
  filePath?: string
  offset: number
  carry: string
  remainingBytes?: number
  decoder?: StringDecoder
  discardingLine?: boolean
  pendingRecords?: JsonRecord[]
  lineStartOffset?: number
}

type JsonRecord = Record<string, unknown>
function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}
/** Returns undefined when the file is unreadable, distinguishing a vanished rollout from one with no new lines. */
export async function readJsonlCursor(
  cursor: JsonlCursor,
  budget: TranscriptReadBudget
): Promise<JsonRecord[] | undefined> {
  if (cursor.pendingRecords) {
    const records = cursor.pendingRecords
    cursor.pendingRecords = undefined
    if (cursor.filePath) {
      try {
        cursor.remainingBytes = Math.max(0, (await stat(cursor.filePath)).size - cursor.offset)
      } catch {
        cursor.remainingBytes = 0
      }
    }
    return records
  }
  if (!cursor.filePath) {
    return undefined
  }
  let stats: Stats
  try {
    stats = await stat(cursor.filePath)
  } catch {
    return undefined
  }
  if (!stats.isFile()) {
    return undefined
  }
  if (stats.size < cursor.offset) {
    cursor.offset = 0
    cursor.lineStartOffset = 0
    cursor.carry = ''
    cursor.decoder = undefined
    cursor.discardingLine = false
  }
  cursor.remainingBytes = stats.size - cursor.offset
  if (stats.size === cursor.offset) {
    return []
  }
  const bytesToRead = Math.min(
    stats.size - cursor.offset,
    TRANSCRIPT_READ_MAX_BYTES,
    budget.remaining
  )
  if (bytesToRead === 0) {
    return []
  }
  budget.remaining -= bytesToRead
  const start = cursor.offset
  let bytesRead = 0
  let fd: FileHandle | undefined
  const release = await transcriptReads.acquire(0)
  const buffer = Buffer.allocUnsafe(bytesToRead)
  try {
    fd = await open(cursor.filePath, 'r')
    bytesRead = (await fd.read(buffer, 0, bytesToRead, start)).bytesRead
  } catch {
    return undefined
  } finally {
    try {
      if (fd !== undefined) {
        await fd.close()
      }
    } finally {
      release()
    }
  }
  cursor.decoder ??= new StringDecoder('utf8')
  const content = `${cursor.carry}${cursor.decoder.write(buffer.subarray(0, bytesRead))}`
  const lines = content.split('\n')
  cursor.offset = start + bytesRead
  const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10)
  if (lastNewline !== -1) {
    cursor.lineStartOffset = start + lastNewline + 1
  }
  cursor.remainingBytes = Math.max(0, stats.size - cursor.offset)
  cursor.carry = lines.pop() ?? ''
  if (cursor.discardingLine && lines.length > 0) {
    lines.shift()
    cursor.discardingLine = false
  }
  if (
    cursor.discardingLine ||
    Buffer.byteLength(cursor.carry, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES
  ) {
    cursor.carry = ''
    cursor.discardingLine = true
  }
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > TRANSCRIPT_LINE_MAX_BYTES) {
      continue
    }
    try {
      const parsed = record(JSON.parse(line) as unknown)
      if (parsed) {
        records.push(parsed)
      }
    } catch {
      // A malformed rollout line must not block later lifecycle events.
    }
  }
  return records
}

async function readTranscriptDirectory(directory: string): Promise<string[]> {
  const entries: string[] = []
  try {
    const handle = await opendir(directory)
    for await (const entry of handle) {
      entries.push(entry.name)
      if (entries.length >= TRANSCRIPT_DIRECTORY_MAX_ENTRIES) {
        break
      }
    }
  } catch {}
  return entries
}

// Why: Codex files each rollout under its OWN local start date, so a session running past midnight spawns children into a sibling day directory.
function childDayDirectory(parentPath: string, startedAt: number): string | undefined {
  const dayDir = dirname(parentPath)
  const monthDir = dirname(dayDir)
  const yearDir = dirname(monthDir)
  if (
    !/^\d{2}$/.test(basename(dayDir)) ||
    !/^\d{2}$/.test(basename(monthDir)) ||
    !/^\d{4}$/.test(basename(yearDir)) ||
    !Number.isFinite(startedAt)
  ) {
    return undefined
  }
  const startedOn = new Date(startedAt)
  if (Number.isNaN(startedOn.getTime())) {
    return undefined
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return join(
    dirname(yearDir),
    String(startedOn.getFullYear()).padStart(4, '0'),
    pad(startedOn.getMonth() + 1),
    pad(startedOn.getDate())
  )
}

export async function resolveChildTranscript(
  parentPath: string,
  threadId: string,
  startedAt: number,
  entriesByDirectory: Map<string, string[]>
): Promise<string | undefined> {
  if (!SAFE_THREAD_ID.test(threadId)) {
    return undefined
  }
  const suffix = `-${threadId}.jsonl`
  const parentDir = dirname(parentPath)
  const childDir = childDayDirectory(parentPath, startedAt)
  const directories = childDir && childDir !== parentDir ? [parentDir, childDir] : [parentDir]
  for (const directory of directories) {
    let entries = entriesByDirectory.get(directory)
    if (!entries) {
      entries = await readTranscriptDirectory(directory)
      entriesByDirectory.set(directory, entries)
    }
    const fileName = entries.find((entry) => entry.endsWith(suffix))
    if (fileName) {
      return join(directory, fileName)
    }
  }
  return undefined
}
