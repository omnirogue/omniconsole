import { open, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { hostname } from 'node:os'

const MAX_LEDGER_BYTES = 16_777_216

export async function readBoundedJson(path, limit = 32_768) {
  const text = await readBoundedText(path, limit)
  return JSON.parse(text)
}
async function readBoundedText(path, limit) {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > limit) {
      throw new Error('file_too_large')
    }
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const after = await file.stat()
    if (
      bytesRead > limit ||
      before.size !== bytesRead ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('file_changed')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}
export async function readDecisionLedger(path, allowMissing = false) {
  let text
  try {
    text = await readBoundedText(path, MAX_LEDGER_BYTES)
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  if (text && !text.endsWith('\n')) {
    throw new Error('incomplete_ledger')
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function withDecisionLedger(path, work) {
  const ledgerPath = resolve(path)
  const lockPath = `${ledgerPath}.lock`
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })
    )
    await lock.sync()
    const rows = await readDecisionLedger(ledgerPath, true)
    const row = await work(rows)
    const text = `${JSON.stringify(row)}\n`
    const ledger = await open(ledgerPath, 'a', 0o600)
    try {
      if ((await ledger.stat()).size + Buffer.byteLength(text) > MAX_LEDGER_BYTES) {
        throw new Error('ledger_too_large')
      }
      await ledger.writeFile(text)
      await ledger.sync()
    } finally {
      await ledger.close()
    }
    return row
  } finally {
    try {
      await lock.close()
    } finally {
      await unlink(lockPath)
    }
  }
}
