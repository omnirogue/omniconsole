import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FRAME_LOG_MAX_RECORD_BYTES } from '../../shared/session-frame-log'
import {
  _configureSessionFrameLogForTests,
  _resetSessionFrameLogForTests,
  flushSessionFrameLog,
  getSessionFrameLogStatus,
  restoreSessionFrameLogFromDisk,
  setSessionFrameLogEnabled
} from './session-frame-log'
import { appendRendererSessionFrameRecords } from './session-frame-log-renderer-records'

const HOUR = 60 * 60 * 1000

function readKinds(directory: string): string[] {
  return readFileSync(join(directory, 'session-frames.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { kind: string }).kind)
}

describe('session frame log: switch', () => {
  let directory: string

  beforeEach(async () => {
    await _resetSessionFrameLogForTests()
    directory = mkdtempSync(join(tmpdir(), 'frame-log-switch-'))
    _configureSessionFrameLogForTests({ directory })
  })

  afterEach(async () => {
    await _resetSessionFrameLogForTests()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  it('switches on and off at runtime, survives a restart, and writes through the async sink', async () => {
    expect(getSessionFrameLogStatus()).toMatchObject({
      enabled: false,
      expiresAt: null,
      maxFiles: 8
    })

    const on = setSessionFrameLogEnabled(true, 'test')
    expect(on).toMatchObject({ enabled: true, filePath: join(directory, 'session-frames.ndjson') })
    expect(on.expiresAt! - on.enabledAt!).toBeGreaterThanOrEqual(8 * HOUR - 1000)
    expect(existsSync(join(directory, 'session-frames.on'))).toBe(true)

    // A restart: module state gone (after its queue drained), the flag file remains.
    await _resetSessionFrameLogForTests()
    _configureSessionFrameLogForTests({ directory })
    restoreSessionFrameLogFromDisk()
    expect(getSessionFrameLogStatus().enabled).toBe(true)

    expect(setSessionFrameLogEnabled(false, 'test').enabled).toBe(false)
    expect(existsSync(join(directory, 'session-frames.on'))).toBe(false)
    await flushSessionFrameLog()
    expect(readKinds(directory)).toEqual(['log.start', 'log.start', 'log.stop'])
    const start = JSON.parse(
      readFileSync(join(directory, 'session-frames.ndjson'), 'utf8').split('\n')[0]!
    ) as Record<string, unknown>
    expect(start.writerStacks).toMatch(/hidden sourcemaps/)
  })

  it('expires on its own, caps the duration at 48 hours, and does not resume once expired', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 4, 18, 0, 0))
    const on = setSessionFrameLogEnabled(true, 'test', { durationMs: 100 * HOUR })
    expect(on.expiresAt).toBe(Date.now() + 48 * HOUR)
    const extended = setSessionFrameLogEnabled(true, 'test', { durationMs: 2 * HOUR })
    expect(extended.expiresAt).toBe(Date.now() + 2 * HOUR)

    vi.advanceTimersByTime(2 * HOUR + 1)
    expect(getSessionFrameLogStatus().enabled).toBe(false)
    expect(existsSync(join(directory, 'session-frames.on'))).toBe(false)

    writeFileSync(
      join(directory, 'session-frames.on'),
      JSON.stringify({ enabledAt: 1, expiresAt: Date.now() - 1 })
    )
    restoreSessionFrameLogFromDisk()
    expect(getSessionFrameLogStatus().enabled).toBe(false)
    expect(existsSync(join(directory, 'session-frames.on'))).toBe(false)
  })
})

describe('session frame log: renderer records', () => {
  let records: Record<string, unknown>[]

  beforeEach(async () => {
    await _resetSessionFrameLogForTests()
    records = []
    _configureSessionFrameLogForTests({
      directory: tmpdir(),
      writerFactory: () => ({
        push: (record) => records.push(record as Record<string, unknown>),
        flush: async () => {}
      })
    })
  })

  afterEach(async () => {
    setSessionFrameLogEnabled(false, 'test')
    await _resetSessionFrameLogForTests()
  })

  it('admits nothing while the log is off', () => {
    expect(appendRendererSessionFrameRecords([{ kind: 'receiver.frame' }], 3)).toBe(0)
    expect(records).toEqual([])
  })

  it('keeps main’s ordering keys, admits only receiver/renderer kinds, and rejects junk', () => {
    setSessionFrameLogEnabled(true, 'test')
    records.length = 0

    const admitted = appendRendererSessionFrameRecords(
      [
        { kind: 'receiver.frame', seq: -1, pid: 1, side: 'owner', t: 42, worktree: 'w' },
        { kind: 'owner.store', worktree: 'w' },
        { kind: 'log.stop' },
        'not a record',
        ['kind'],
        { worktree: 'no kind' }
      ],
      7
    )

    expect(admitted).toBe(1)
    expect(records[0]).toMatchObject({
      kind: 'receiver.frame',
      worktree: 'w',
      side: 'renderer',
      rendererT: 42,
      sender: 7,
      pid: process.pid
    })
    expect(records[0]!.seq).toBeGreaterThan(0)
    expect(records[1]).toMatchObject({ kind: 'main.renderer-batch-refused', rejected: 5 })
    expect(appendRendererSessionFrameRecords('not an array')).toBe(0)
  })

  it('replaces an oversized record with a flagged, truncated stand-in and caps the batch', () => {
    setSessionFrameLogEnabled(true, 'test')
    records.length = 0

    appendRendererSessionFrameRecords([
      { kind: 'receiver.apply', huge: 'x'.repeat(SESSION_FRAME_LOG_MAX_RECORD_BYTES + 10) }
    ])
    expect(records[0]).toMatchObject({ kind: 'receiver.apply', truncated: true, side: 'renderer' })
    expect(JSON.stringify(records[0]).length).toBeLessThan(SESSION_FRAME_LOG_MAX_RECORD_BYTES)

    records.length = 0
    const batch = Array.from({ length: 510 }, () => ({ kind: 'renderer.sidebar-counts' }))
    expect(appendRendererSessionFrameRecords(batch)).toBe(500)
    expect(records.at(-1)).toMatchObject({ kind: 'main.renderer-batch-refused', dropped: 10 })
  })
})
