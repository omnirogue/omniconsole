import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { COMMAND_SPECS } from '../specs'
import { JEV_RECORDS_RUNTIME_CAPABILITY } from '../../shared/jev-ledger'
import { JEV_RECORD_HANDLERS } from './jev-records'

let dir: string
const key = 'jev-rubric:00000000-0000-4000-8000-0000000000aa'
const outcome = {
  question_id: 'quality',
  label: 'approve',
  evidence_level: 'verification',
  source: 'human',
  labeler: `sha256:${'0'.repeat(64)}`,
  blind: true,
  recorded_at: '2026-10-01T13:00:00Z'
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jev-records-cli-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('ORCA_CLI_CWD', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function invocation(
  argv: string[],
  capabilities: string[] = [JEV_RECORDS_RUNTIME_CAPABILITY],
  pages: { rows: unknown[]; cursor: string | null }[] = []
) {
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(['jev', ...argv]))
  const call = vi.fn(async (method: string, _params?: unknown) => ({
    id: 'request',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities }
        : method === 'jev.records.export'
          ? pages.shift()
          : { ok: method }
  }))
  return {
    call,
    run: () =>
      JEV_RECORD_HANDLERS[parsed.commandPath.join(' ')]!({
        flags: parsed.flags,
        client: { call } as unknown as RuntimeClient,
        cwd: dir,
        json: true
      })
  }
}

describe('JEV records CLI', () => {
  it.each([[['records', 'list']], [['outcome', key, '--file', 'outcome.json']]])(
    'refuses %j on an older runtime without reading the ledger',
    async (argv) => {
      writeFileSync(join(dir, 'outcome.json'), JSON.stringify(outcome))
      const command = invocation(argv, ['jev.rubrics.v1'])
      await expect(command.run()).rejects.toMatchObject({
        code: 'unsupported_runtime_capability',
        message: expect.stringContaining('Update that runtime')
      })
      expect(command.call).toHaveBeenCalledExactlyOnceWith('status.get')
    }
  )

  it('normalizes list filters to UTC and validates them before contacting the runtime', async () => {
    const command = invocation([
      'records',
      'list',
      '--since',
      '2026-10-03T08:00:00-04:00',
      '--caller',
      'jev.rubrics.evaluate',
      '--limit',
      '20'
    ])
    await command.run()
    expect(command.call).toHaveBeenLastCalledWith('jev.records.list', {
      since: '2026-10-03T12:00:00.000Z',
      caller: 'jev.rubrics.evaluate',
      limit: 20
    })
    for (const argv of [
      ['records', 'list', '--since', '2026-10-03T08:00'],
      ['records', 'list', '--since', 'yesterday'],
      ['records', 'list', '--since', '2026-02-30'],
      ['records', 'list', '--since', '2026-10-03T24:00:00Z'],
      ['records', 'list', '--limit', '0'],
      ['records', 'list', '--limit', '1001'],
      ['records', 'list', '--caller', 'two words']
    ]) {
      const invalid = invocation(argv)
      await expect(invalid.run()).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(invalid.call).not.toHaveBeenCalled()
    }
  })

  it('reports export errors on stderr only, so a redirected rows file stays NDJSON', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const older = invocation(['records', 'export'], ['jev.rubrics.v1'])
      await older.run()
      expect(older.call).toHaveBeenCalledExactlyOnceWith('status.get')
      expect(process.exitCode).toBe(1)
      expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'unsupported_runtime_capability' }
      })

      process.exitCode = undefined
      stderr.mockClear()
      const stalled = invocation(['records', 'export'], undefined, [
        { rows: [{ schema: 'jev-call/1', n: 1 }], cursor: 'next-page' },
        { rows: [], cursor: 'next-page' }
      ])
      await stalled.run()
      expect(process.exitCode).toBe(1)
      expect(String(stderr.mock.calls[0]?.[0])).toContain('made no progress')
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join('')
      expect(
        output
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      ).toEqual([{ schema: 'jev-call/1', n: 1 }])
      expect(console.log).not.toHaveBeenCalled()

      process.exitCode = undefined
      stderr.mockClear()
      const impossible = invocation(['records', 'export', '--since', '2026-02-30'])
      await impossible.run()
      expect(impossible.call).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(String(stderr.mock.calls[0]?.[0])).toContain('invalid_argument')
    } finally {
      process.exitCode = undefined
    }
  })

  it('streams every export page to stdout as NDJSON', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const rows = [
      { schema: 'jev-call/1', n: 1 },
      { schema: 'jev-call/1', n: 2 },
      { schema: 'jev-outcome/1' }
    ]
    const command = invocation(['records', 'export', '--since', '2026-10-02'], undefined, [
      { rows: rows.slice(0, 2), cursor: 'next-page' },
      { rows: rows.slice(2), cursor: null }
    ])
    await command.run()
    expect(command.call.mock.calls.slice(1)).toEqual([
      ['jev.records.export', { since: '2026-10-02T00:00:00.000Z' }],
      ['jev.records.export', { since: '2026-10-02T00:00:00.000Z', cursor: 'next-page' }]
    ])
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    ).toEqual(rows)
  })

  it('sends a validated outcome for the positional record key', async () => {
    writeFileSync(join(dir, 'outcome.json'), JSON.stringify(outcome))
    const command = invocation(['outcome', key, '--file', 'outcome.json'])
    await command.run()
    expect(command.call).toHaveBeenLastCalledWith('jev.outcome', {
      record_key: key,
      outcome: { ...outcome, correction_minutes: null, note: null }
    })
  })

  it('requires piped stdin from a forwarded SSH/WSL shell', async () => {
    writeFileSync(join(dir, 'outcome.json'), JSON.stringify(outcome))
    vi.stubEnv('ORCA_CLI_CWD', '/remote/work')
    const file = invocation(['outcome', key, '--file', 'outcome.json'])
    await expect(file.run()).rejects.toThrow('Pipe the host file')
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([JSON.stringify(outcome)]) as typeof process.stdin
    )
    const piped = invocation(['outcome', key, '--input-stdin'])
    await piped.run()
    expect(piped.call).toHaveBeenLastCalledWith(
      'jev.outcome',
      expect.objectContaining({ record_key: key })
    )
  })

  it.each([
    [['outcome', 'jev-rubric:not-a-uuid', '--file', 'outcome.json'], outcome],
    [['outcome', key, '--file', 'outcome.json'], { ...outcome, source: 'agent' }],
    [['outcome', key, '--file', 'outcome.json'], { ...outcome, note: 'reach me at a@b.example' }],
    [['outcome', key, '--file', 'outcome.json'], { ...outcome, extra: true }],
    [['outcome', key, '--file', 'outcome.json'], { ...outcome, labeler: 'reviewer@example.test' }]
  ])('refuses an invalid key or outcome before writing: %j', async (argv, input) => {
    writeFileSync(join(dir, 'outcome.json'), JSON.stringify(input))
    const command = invocation(argv)
    await expect(command.run()).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(command.call.mock.calls.map(([method]) => method)).not.toContain('jev.outcome')
  })
})
