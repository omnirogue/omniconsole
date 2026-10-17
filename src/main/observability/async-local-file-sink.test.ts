import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeFs from 'node:fs/promises'
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof NodeFs>()
  return { ...fs, appendFile: vi.fn(fs.appendFile) }
})
import { createAsyncLocalFileSink } from './async-local-file-sink'
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(appendFile).mockClear()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
function open(maxBytes = 1024) {
  const dir = mkdtempSync(join(tmpdir(), 'launch-async-'))
  dirs.push(dir)
  const path = join(dir, 'launch.ndjson')
  return { path, dir, sink: createAsyncLocalFileSink({ filePath: path, maxBytes, maxFiles: 3 }) }
}
describe('ordered asynchronous launch writes', () => {
  it('returns from push while a disk append is blocked and preserves row order', async () => {
    let release = () => {}
    let started = () => {}
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const real = vi.mocked(appendFile).getMockImplementation()!
    vi.mocked(appendFile).mockImplementationOnce(async (...args) => {
      started()
      await gate
      await real(...args)
    })
    const { path, sink } = open()
    try {
      sink.push({ process: 'prepared' })
      sink.push({ process: 'created' })
      await began
      expect(appendFile).toHaveBeenCalledOnce()
    } finally {
      release()
    }
    await sink.flush()
    expect(readFileSync(path, 'utf8')).toBe('{"process":"prepared"}\n{"process":"created"}\n')
  })
  it('recovers its queue after a failed write without rejecting flush', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(appendFile).mockRejectedValueOnce(new Error('private disk error'))
    const { path, sink } = open()
    sink.push({ process: 'prepared' })
    sink.push({ process: 'created' })
    await expect(sink.flush()).resolves.toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('{"process":"created"}\n')
    expect(console.warn).toHaveBeenCalledWith('[launch-ledger] asynchronous write unavailable')
  })
  it('rotates off the caller path and bounds the retained file family', async () => {
    const { path, dir, sink } = open(64)
    for (let i = 0; i < 10; i++) {
      sink.push({ row: i, text: '1234567890' })
      await sink.flush()
    }
    expect(readdirSync(dir)).toHaveLength(3)
    for (const file of readdirSync(dir)) {
      expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(64)
    }
    expect(readFileSync(path, 'utf8')).toContain('"row":9')
  })
})
