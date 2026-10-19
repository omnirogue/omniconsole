import { appendFile, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JEV_CALLS_FILE,
  JevLedger,
  installJevLedger,
  jevCallLedger,
  ledgerWriteWithin,
  uninstallJevLedger,
  type JevCallFields
} from './jev-ledger'
import {
  jevCallFieldsFixture as callFields,
  ledgerDirectories,
  readLedgerLines
} from './jev-ledger.test-fixture'

const directories = ledgerDirectories()
afterEach(() => directories.cleanup())

describe('JEV call ledger writer', () => {
  it('appends one jev-call/1 line in contract order with a private directory and file', async () => {
    const directory = await directories.create()
    const ledger = new JevLedger(directory, { host: 'fixture-host', runtimeId: 'runtime-1' })

    await expect(ledger.appendCall(callFields())).resolves.toBe('saved')

    const [row] = await readLedgerLines(join(directory, JEV_CALLS_FILE))
    expect(Object.keys(row!)).toEqual([
      'schema',
      'record_key',
      'request_id',
      'observed_at',
      'host',
      'runtime_id',
      'caller',
      'transport',
      'deadline_ms',
      'model',
      'ref',
      'ref_hash',
      'input_hash',
      'question_ids',
      'status',
      'provider_status',
      'kind',
      'reason',
      'answers',
      'usage',
      'elapsed_ms',
      'calls'
    ])
    expect(row).toMatchObject({
      schema: 'jev-call/1',
      host: 'fixture-host',
      runtime_id: 'runtime-1'
    })
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, JEV_CALLS_FILE))).mode & 0o777).toBe(0o600)
    }
  })

  it('serializes concurrent appends so every row stays one whole line', async () => {
    const directory = await directories.create()
    const ledger = new JevLedger(directory, { host: 'h', runtimeId: null })
    const writes = Array.from({ length: 40 }, (_, index) =>
      ledger.appendCall(callFields({ question_ids: [`q${index}`] }))
    )
    expect(await Promise.all(writes)).toEqual(Array(40).fill('saved'))
    const rows = await readLedgerLines(join(directory, JEV_CALLS_FILE))
    expect(rows.map((row) => (row.question_ids as string[])[0])).toEqual(
      writes.map((_, index) => `q${index}`)
    )
  })

  it('rotates to calls-<UTC time>.jsonl before a file would reach its limit', async () => {
    const probe = await directories.create()
    await new JevLedger(probe, { host: 'h', runtimeId: null }).appendCall(callFields())
    const line = (await stat(join(probe, JEV_CALLS_FILE))).size
    const directory = await directories.create()
    const limit = line * 3 + 10
    const ledger = new JevLedger(directory, { host: 'h', runtimeId: null }, limit)
    for (let index = 0; index < 7; index++) {
      expect(await ledger.appendCall(callFields())).toBe('saved')
    }
    const names = await readdir(directory)
    const rotated = names.filter((name) => name !== JEV_CALLS_FILE)
    expect(rotated).toHaveLength(2)
    for (const name of rotated) {
      expect(name).toMatch(/^calls-\d{8}T\d{9}Z(?:-\d+)?\.jsonl$/)
    }
    let rows = 0
    for (const name of names) {
      expect((await stat(join(directory, name))).size).toBeLessThan(limit)
      rows += (await readLedgerLines(join(directory, name))).length
    }
    expect(rows).toBe(7)
  })

  it('keeps same-tick rotations in append order past single-digit suffixes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-10-05T00:00:00Z'))
    try {
      const probe = new JevLedger(await directories.create(), { host: 'h', runtimeId: null })
      await probe.appendCall(callFields({ question_ids: ['q0'] }))
      const limit = (await stat(join(probe.directory, JEV_CALLS_FILE))).size * 2 - 1
      const ledger = new JevLedger(
        await directories.create(),
        { host: 'h', runtimeId: null },
        limit
      )
      for (let index = 0; index < 14; index++) {
        expect(await ledger.appendCall(callFields({ question_ids: [`q${index}`] }))).toBe('saved')
      }
      const names = (await readdir(ledger.directory))
        .filter((name) => name !== JEV_CALLS_FILE)
        .toSorted()
      expect(names).toHaveLength(13)
      const rows = (
        await Promise.all(names.map((name) => readLedgerLines(join(ledger.directory, name))))
      ).flat()
      expect(rows.map((row) => (row.question_ids as string[])[0])).toEqual(
        Array.from({ length: 13 }, (_, index) => `q${index}`)
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh line after a torn last line, so no saved row is lost', async () => {
    const directory = await directories.create()
    const ledger = new JevLedger(directory, { host: 'h', runtimeId: null })
    await ledger.appendCall(callFields({ question_ids: ['before'] }))
    const path = join(directory, JEV_CALLS_FILE)
    await appendFile(path, '{"schema":"jev-call/1","record_key":"jev-call:torn')
    for (let index = 0; index < 3; index++) {
      expect(await ledger.appendCall(callFields({ question_ids: [`after${index}`] }))).toBe('saved')
    }
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(5)
    expect(lines[1]).toBe('{"schema":"jev-call/1","record_key":"jev-call:torn')
    expect(
      [lines[0], ...lines.slice(2)].map(
        (line) => (JSON.parse(line!) as { question_ids: string[] }).question_ids[0]
      )
    ).toEqual(['before', 'after0', 'after1', 'after2'])
  })

  it('never throws into the caller: a failed or malformed write is counted and reported', async () => {
    const directory = await directories.create()
    await mkdir(dirname(dirname(directory)), { recursive: true })
    await writeFile(dirname(directory), 'not a directory')
    const ledger = new JevLedger(directory, { host: 'h', runtimeId: null })
    await expect(ledger.appendCall(callFields())).resolves.toBe('failed')
    await expect(ledger.appendCall(undefined as unknown as JevCallFields)).resolves.toBe('failed')
    ledger.countFailure()
    expect(ledger.writeFailures).toBe(3)
  })

  it('reports a write that has not settled in time as pending', async () => {
    await expect(ledgerWriteWithin(new Promise<'saved'>(() => {}), 5)).resolves.toBe('pending')
    await expect(ledgerWriteWithin(Promise.resolve('failed'), 5)).resolves.toBe('failed')
  })

  it('keeps one process ledger and uninstalls only its own instance', async () => {
    const first = installJevLedger(await directories.create(), { host: 'h', runtimeId: null })
    const second = installJevLedger(await directories.create(), { host: 'h', runtimeId: null })
    uninstallJevLedger(first)
    expect(jevCallLedger()).toBe(second)
    uninstallJevLedger(second)
    expect(jevCallLedger()).toBeUndefined()
  })
})
