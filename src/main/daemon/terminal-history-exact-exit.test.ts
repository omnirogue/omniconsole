import { createHash } from 'node:crypto'
import type * as fs from 'node:fs'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TAIL_CHARS,
  MAX_TAIL_LINES,
  MAX_TAIL_PARTIAL_CHARS,
  type TerminalStreamSnapshot
} from '../../shared/terminal-stream'
import { HistoryManager } from './history-manager'
import { getHistorySessionDirName } from './history-paths'
import {
  readTerminalHistoryExactExit,
  writeTerminalHistoryExactExit,
  type TerminalHistoryExactExit
} from './terminal-history-exact-exit'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    readSync: vi.fn(actual.readSync)
  }
})

function streamFixture(): TerminalStreamSnapshot {
  return {
    version: 1,
    lines: ['first command', 'second command'],
    previewLines: ['updated display'],
    partialLine: 'partial',
    completedLineCount: 4,
    truncated: true
  }
}

const sparseLines: string[] = []
sparseLines.length = 1

describe.skipIf(process.platform === 'win32')('exact terminal history exit evidence', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'terminal-history-exit-'))
    roots.push(root)
    const basePath = join(root, 'history')
    const observation: TerminalHistoryExactExit = {
      version: 1,
      sessionId: 'repo/path:worker',
      incarnationId: 'incarnation-original',
      pid: 12345,
      observedAt: '2026-09-09T12:34:56.789Z',
      exitCause: { kind: 'exited', exitCode: 0 },
      exitCode: 0
    }
    const directory = join(basePath, getHistorySessionDirName(observation.sessionId))
    const hash = createHash('sha256').update(observation.incarnationId).digest('hex')
    const file = join(directory, `exact-exit-${hash}.json`)
    return { root, basePath, directory, file, observation }
  }

  it('persists before metadata exists and survives metadata initialization and rewrites', async () => {
    const { basePath, directory, file, observation } = fixture()
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'missing' })
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(readdirSync(directory)).toEqual([file.slice(directory.length + 1)])

    const manager = new HistoryManager(basePath)
    await manager.openSession(observation.sessionId, { cwd: '/work', cols: 80, rows: 24 })
    await manager.closeSession(observation.sessionId, 99)
    manager.reopenSession(observation.sessionId)
    await manager.dispose()

    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation })
    expect(JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8')).exitCode).toBeNull()
  })

  it('retains the first exact observation and refuses conflicting replacement', () => {
    const { basePath, directory, observation } = fixture()
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    expect(
      writeTerminalHistoryExactExit(basePath, {
        ...observation,
        exitCause: { kind: 'exited', exitCode: 42 },
        exitCode: 42
      })
    ).toBe(false)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation })
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it('keeps the terminal snapshot immutable with its exact exit observation', () => {
    const { basePath, directory, observation } = fixture()
    const recorded = { ...observation, terminalStream: streamFixture() }
    expect(writeTerminalHistoryExactExit(basePath, recorded)).toBe(true)
    expect(writeTerminalHistoryExactExit(basePath, structuredClone(recorded))).toBe(true)
    const replacement = structuredClone(recorded)
    replacement.terminalStream.lines[0] = 'replacement output'
    expect(writeTerminalHistoryExactExit(basePath, replacement)).toBe(false)
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(false)
    const read = readTerminalHistoryExactExit(
      basePath,
      observation.sessionId,
      observation.incarnationId
    )
    expect(read).toEqual({ status: 'readable', observation: recorded })
    if (read.status === 'readable') {
      read.observation.terminalStream!.previewLines[0] = 'mutated read'
    }
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation: recorded })
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it('reads legacy evidence without a snapshot and refuses to amend it later', () => {
    const { basePath, directory, file, observation } = fixture()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(observation), { mode: 0o600 })
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation })
    expect(
      writeTerminalHistoryExactExit(basePath, { ...observation, terminalStream: streamFixture() })
    ).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(observation)
  })

  it.each([
    ['escaped controls', '\u0001'],
    ['multibyte characters', '\u4e16']
  ])('round-trips maximum character windows containing %s', (_name, character) => {
    const { basePath, file, observation } = fixture()
    const text = character.repeat(MAX_TAIL_CHARS)
    const recorded: TerminalHistoryExactExit = {
      ...observation,
      terminalStream: {
        version: 1,
        lines: [text],
        previewLines: [text],
        partialLine: '',
        completedLineCount: 1,
        truncated: false
      }
    }
    expect(writeTerminalHistoryExactExit(basePath, recorded)).toBe(true)
    expect(statSync(file).size).toBeGreaterThan(2 * MAX_TAIL_CHARS)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation: recorded })
  })

  it.each([
    ['null', null],
    ['array', []],
    ['missing fields', {}],
    ['wrong version', { ...streamFixture(), version: 2 }],
    ['non-array lines', { ...streamFixture(), lines: {} }],
    ['non-string line', { ...streamFixture(), lines: [null] }],
    ['sparse lines', { ...streamFixture(), lines: sparseLines }],
    ['excess lines', { ...streamFixture(), lines: Array(MAX_TAIL_LINES + 1).fill('') }],
    ['excess line characters', { ...streamFixture(), lines: ['x'.repeat(MAX_TAIL_CHARS + 1)] }],
    ['non-array preview', { ...streamFixture(), previewLines: 'line' }],
    ['non-string preview', { ...streamFixture(), previewLines: [1] }],
    [
      'excess preview lines',
      { ...streamFixture(), previewLines: Array(MAX_TAIL_LINES + 1).fill('') }
    ],
    [
      'excess preview characters',
      { ...streamFixture(), previewLines: ['x'.repeat(MAX_TAIL_CHARS)] }
    ],
    ['non-string partial', { ...streamFixture(), partialLine: 1 }],
    ['excess partial', { ...streamFixture(), partialLine: 'x'.repeat(MAX_TAIL_PARTIAL_CHARS + 1) }],
    ['negative count', { ...streamFixture(), completedLineCount: -1 }],
    ['fractional count', { ...streamFixture(), completedLineCount: 2.5 }],
    ['unsafe count', { ...streamFixture(), completedLineCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['inconsistent count', { ...streamFixture(), completedLineCount: 1 }],
    ['non-boolean truncation', { ...streamFixture(), truncated: 1 }]
  ])('refuses malformed terminal snapshots on write and read: %s', (_name, terminalStream) => {
    const { basePath, directory, file, observation } = fixture()
    const invalid = { ...observation, terminalStream }
    expect(writeTerminalHistoryExactExit(basePath, invalid as TerminalHistoryExactExit)).toBe(false)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(invalid), { mode: 0o600 })
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'unreadable' })
  })

  it('keeps different incarnations of one session independently readable', () => {
    const { basePath, observation } = fixture()
    const replacement = { ...observation, incarnationId: 'incarnation-replacement', pid: 54321 }
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    expect(writeTerminalHistoryExactExit(basePath, replacement)).toBe(true)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation })
    expect(
      readTerminalHistoryExactExit(basePath, replacement.sessionId, replacement.incarnationId)
    ).toEqual({ status: 'readable', observation: replacement })
    expect(readTerminalHistoryExactExit(basePath, observation.sessionId, 'never-observed')).toEqual(
      { status: 'missing' }
    )
  })

  it.each([
    { kind: 'signaled' as const, signal: 9 },
    { kind: 'operator_close' as const },
    { kind: 'unknown' as const, reason: 'host_status_unavailable' as const },
    { kind: 'unknown' as const, reason: 'cause_unreported' as const }
  ])('preserves a certified $kind death without inventing exit code zero', (exitCause) => {
    const { basePath, observation } = fixture()
    const unknownCode = { ...observation, exitCause, exitCode: null }
    expect(writeTerminalHistoryExactExit(basePath, unknownCode)).toBe(true)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation: unknownCode })
  })

  it.each([
    { pid: 0 },
    { pid: 1.5 },
    { version: 2 },
    { sessionId: '..' },
    { incarnationId: '' },
    { incarnationId: 'invalid\0incarnation' },
    { observedAt: 'yesterday' },
    { observedAt: '2026-02-30T12:34:56.789Z' },
    { exitCause: { kind: 'unknown', reason: 'stop_unverified' }, exitCode: null },
    { exitCause: { kind: 'signaled', signal: 9 }, exitCode: 0 },
    { exitCause: { kind: 'exited', exitCode: -1 }, exitCode: -1 },
    { exitCode: 42 }
  ])('refuses invalid or unverified evidence: %j', (changes) => {
    const { basePath, observation } = fixture()
    expect(
      writeTerminalHistoryExactExit(basePath, {
        ...observation,
        ...changes
      } as TerminalHistoryExactExit)
    ).toBe(false)
  })

  it.each([
    { sessionId: 'different-session' },
    { incarnationId: 'different-incarnation' },
    { pid: 0 },
    { exitCause: { kind: 'unknown', reason: 'stop_unverified' }, exitCode: null }
  ])('refuses misplaced or invalid stored evidence: %j', (changes) => {
    const { basePath, directory, file, observation } = fixture()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify({ ...observation, ...changes }), { mode: 0o600 })
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'unreadable' })
  })

  it('rejects public, oversized, and malformed evidence files', () => {
    const { basePath, file, observation } = fixture()
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    chmodSync(file, 0o644)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
        .status
    ).toBe('unreadable')
    chmodSync(file, 0o600)
    writeFileSync(file, 'x'.repeat(4 * 1024 * 1024 + 1))
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
        .status
    ).toBe('unreadable')
    writeFileSync(file, '{')
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
        .status
    ).toBe('unreadable')
  })

  it('bounds each read to the observed file size and detects growth after stat', async () => {
    const { basePath, file, observation } = fixture()
    const actual = await vi.importActual<typeof fs>('node:fs')
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    const size = statSync(file).size
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation })
    expect(vi.mocked(readSync).mock.calls[0]?.[1].byteLength).toBe(size + 1)
    vi.mocked(readSync).mockImplementationOnce((...args) => {
      appendFileSync(file, ' ')
      return actual.readSync(...args)
    })
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'unreadable' })
  })

  it('refuses symlinked files and session directories', () => {
    const { root, basePath, directory, file, observation } = fixture()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const target = join(root, 'private.json')
    writeFileSync(target, JSON.stringify(observation), { mode: 0o600 })
    symlinkSync(target, file)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
        .status
    ).toBe('unreadable')
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(false)
    rmSync(directory, { recursive: true })
    symlinkSync(root, directory)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
        .status
    ).toBe('unreadable')
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(false)
  })

  it('does not persist extra transcript or environment properties', () => {
    const { basePath, file, observation } = fixture()
    expect(
      writeTerminalHistoryExactExit(basePath, {
        ...observation,
        transcript: 'private output',
        env: { SECRET: 'private value' }
      } as TerminalHistoryExactExit)
    ).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(observation)
  })

  it('persists only the validated snapshot fields', () => {
    const { basePath, file, observation } = fixture()
    const terminalStream = streamFixture()
    expect(
      writeTerminalHistoryExactExit(basePath, {
        ...observation,
        terminalStream: {
          ...terminalStream,
          rawOutput: 'unbounded output',
          env: { SECRET: 'value' }
        }
      } as TerminalHistoryExactExit)
    ).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...observation, terminalStream })
  })

  it('refuses publication when directory durability cannot be established', () => {
    const { basePath, observation } = fixture()
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error('directory fsync unavailable')
    })
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(false)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'missing' })
  })

  it('keeps a readable observation when descriptor cleanup fails', async () => {
    const { basePath, observation } = fixture()
    const actual = await vi.importActual<typeof fs>('node:fs')
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(true)
    vi.mocked(closeSync).mockImplementationOnce((fd) => {
      actual.closeSync(fd)
      throw new Error('close failed')
    })
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'readable', observation })
  })

  it('keeps a failed publication false when directory cleanup also fails', async () => {
    const { basePath, observation } = fixture()
    const actual = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error('directory fsync failed')
    })
    vi.mocked(closeSync).mockImplementationOnce((fd) => {
      actual.closeSync(fd)
      throw new Error('directory close failed')
    })
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(false)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'missing' })
  })

  it('still refuses publication when closing the evidence file fails before linking', async () => {
    const { basePath, observation } = fixture()
    const actual = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(closeSync).mockImplementationOnce((fd) => {
      actual.closeSync(fd)
      throw new Error('evidence close failed')
    })
    expect(writeTerminalHistoryExactExit(basePath, observation)).toBe(false)
    expect(
      readTerminalHistoryExactExit(basePath, observation.sessionId, observation.incarnationId)
    ).toEqual({ status: 'missing' })
  })
})
