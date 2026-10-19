import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JEV_CALLS_FILE, JEV_OUTCOMES_FILE, JevLedger } from './jev-ledger'
import { appendJevOutcome, exportJevRecords, listJevRecords } from './jev-ledger-records'
import { jevCallFieldsFixture, ledgerDirectories, readLedgerLines } from './jev-ledger.test-fixture'

const directories = ledgerDirectories()
const REVIEWER = `sha256:${createHash('sha256').update('reviewer@example.test').digest('hex')}`
afterEach(() => directories.cleanup())

const key = (n: number) => `jev-call:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const call = (n: number, observedAt: string, caller = 'session-owner') =>
  jevCallFieldsFixture({
    record_key: key(n),
    request_id: key(n).slice('jev-call:'.length),
    observed_at: observedAt,
    caller
  })
const label = {
  question_id: 'duplicate',
  label: false,
  evidence_level: 'verification',
  source: 'human',
  labeler: REVIEWER,
  blind: true,
  recorded_at: '2026-10-01T13:00:00Z'
}

async function ledgerWith(rows: number, limit?: number) {
  const ledger = new JevLedger(await directories.create(), { host: 'h', runtimeId: null }, limit)
  for (let n = 1; n <= rows; n++) {
    await ledger.appendCall(
      call(n, `2026-10-0${1 + (n % 3)}T12:00:00.000Z`, n % 2 ? 'session-owner' : 'jev.request')
    )
  }
  return ledger
}

describe('omni jev records list', () => {
  it('summarizes rows newest first, filtered by time and caller, with outcome counts', async () => {
    const ledger = await ledgerWith(6)
    await appendJevOutcome(ledger, { record_key: key(1), outcome: label }, async () => false)

    const all = await listJevRecords(ledger, {})
    const times = all.records.map((row) => row.observed_at)
    expect(times).toEqual(times.toSorted().toReversed())
    expect(all.records.find((row) => row.record_key === key(1))?.outcomes).toBe(1)
    expect(all.records[0]).not.toHaveProperty('answers')
    expect(all.records[0]).not.toHaveProperty('input_hash')
    expect(all).toMatchObject({ truncated: false, ledger: { write_failures: 0 } })

    const filtered = await listJevRecords(ledger, {
      since: '2026-10-02T00:00:00.000Z',
      caller: 'jev.request',
      limit: 1
    })
    expect(filtered.records).toHaveLength(1)
    expect(filtered.records[0]).toMatchObject({ caller: 'jev.request' })
    expect(Date.parse(filtered.records[0]!.observed_at)).toBeGreaterThanOrEqual(
      Date.parse('2026-10-02T00:00:00.000Z')
    )
    expect(filtered.truncated).toBe(true)
  })

  it('reads rotated files too', async () => {
    const ledger = await ledgerWith(9, 2_000)
    expect((await readdir(ledger.directory)).length).toBeGreaterThan(2)
    const listed = await listJevRecords(ledger, { limit: 100 })
    expect(listed.records).toHaveLength(9)
    expect(listed.truncated).toBe(false)
  })
})

describe('omni jev records export', () => {
  it('pages every call row, then every outcome row, across a rotation under the cursor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-10-05T00:00:00Z'))
    try {
      const ledger = await ledgerWith(9, 2_000)
      await appendJevOutcome(ledger, { record_key: key(2), outcome: label }, async () => false)
      const exported: Record<string, unknown>[] = []
      let cursor: string | undefined
      let rotatedUnderCursor = false
      do {
        const page = await exportJevRecords(ledger, cursor ? { cursor } : {}, 1_000)
        exported.push(...(page.rows as Record<string, unknown>[]))
        cursor = page.cursor ?? undefined
        const at = cursor && JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (at?.segment === JEV_CALLS_FILE && !rotatedUnderCursor) {
          const before = (await readdir(ledger.directory)).length
          // Both new rotations share one tick, after the initial segments.
          vi.setSystemTime(Date.now() + 1)
          for (let n = 10; n <= 13; n++) {
            await ledger.appendCall(call(n, `2026-10-04T00:00:0${n - 10}.000Z`))
          }
          rotatedUnderCursor = (await readdir(ledger.directory)).length > before
        }
      } while (cursor)
      expect(rotatedUnderCursor).toBe(true)
      const calls = exported.filter((row) => row.schema === 'jev-call/1')
      expect(calls.map((row) => row.record_key).toSorted()).toEqual(
        Array.from({ length: 13 }, (_, n) => key(n + 1)).toSorted()
      )
      expect(exported.at(-1)).toMatchObject({ schema: 'jev-outcome/1', record_key: key(2) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps rows at or after --since and refuses a cursor that names another file', async () => {
    const ledger = await ledgerWith(6)
    const page = await exportJevRecords(ledger, { since: '2026-10-03T00:00:00.000Z' })
    expect(page.cursor).toBeNull()
    expect(page.rows.length).toBeGreaterThan(0)
    for (const row of page.rows as { observed_at: string }[]) {
      expect(row.observed_at >= '2026-10-03').toBe(true)
    }
    const escape = Buffer.from(
      JSON.stringify({ segment: '../../secret.json', offset: 0, head: null })
    ).toString('base64url')
    await expect(exportJevRecords(ledger, { cursor: escape })).rejects.toThrow('cursor')
  })
})

describe('omni jev records export --since', () => {
  it("always exports outcomes in full: recorded_at is the labeler's time, not the append time", async () => {
    const ledger = new JevLedger(await directories.create(), { host: 'h', runtimeId: null })
    await ledger.appendCall(call(1, '2026-10-02T12:00:00.000Z'))
    const window = { since: '2026-10-03T11:00:00.000Z' }
    expect((await exportJevRecords(ledger, window)).rows).toEqual([])
    await appendJevOutcome(
      ledger,
      { record_key: key(1), outcome: { ...label, recorded_at: '2026-10-02T18:00:00Z' } },
      async () => false,
      new Date('2026-10-03T13:00:00.000Z')
    )
    expect((await exportJevRecords(ledger, window)).rows).toEqual([
      expect.objectContaining({
        schema: 'jev-outcome/1',
        record_key: key(1),
        recorded_at: '2026-10-02T18:00:00.000Z'
      })
    ])
  })

  it('refuses an impossible calendar time instead of rolling it over', async () => {
    const ledger = await ledgerWith(1)
    await expect(
      appendJevOutcome(
        ledger,
        { record_key: key(1), outcome: { ...label, recorded_at: '2026-02-30T00:00:00Z' } },
        async () => false
      )
    ).rejects.toThrow('real calendar time')
    await expect(exportJevRecords(ledger, { since: '2026-02-30T00:00:00.000Z' })).rejects.toThrow(
      'real calendar time'
    )
  })
})

describe('omni jev outcome', () => {
  it('appends a validated jev-outcome/1 row and refuses the same label twice', async () => {
    const ledger = await ledgerWith(1)
    const saved = await appendJevOutcome(
      ledger,
      { record_key: key(1), outcome: label },
      async () => false
    )
    expect(saved).toEqual({
      outcome: {
        schema: 'jev-outcome/1',
        record_key: key(1),
        question_id: 'duplicate',
        label: false,
        evidence_level: 'verification',
        source: 'human',
        labeler: REVIEWER,
        blind: true,
        recorded_at: '2026-10-01T13:00:00.000Z',
        correction_minutes: null,
        note: null
      },
      storage: { status: 'saved', file: JEV_OUTCOMES_FILE }
    })
    await expect(
      appendJevOutcome(
        ledger,
        { record_key: key(1), outcome: { ...label, recorded_at: '2026-10-01T13:00:00.000Z' } },
        async () => false
      )
    ).rejects.toThrow('already recorded')
    await appendJevOutcome(
      ledger,
      {
        record_key: key(1),
        outcome: { ...label, label: true, recorded_at: '2026-10-01T14:00:00Z' }
      },
      async () => false
    )
    expect(await readLedgerLines(join(ledger.directory, JEV_OUTCOMES_FILE))).toHaveLength(2)
  })

  it('needs an existing record, here or in the private records store', async () => {
    const ledger = await ledgerWith(1)
    const stored = vi.fn(async (recordKey: string) => recordKey.startsWith('jev-rubric:'))
    const rubric = 'jev-rubric:00000000-0000-4000-8000-0000000000aa'
    await expect(
      appendJevOutcome(ledger, { record_key: key(9), outcome: label }, stored)
    ).rejects.toThrow('No JEV record')
    await expect(
      appendJevOutcome(ledger, { record_key: rubric, outcome: label }, stored)
    ).resolves.toMatchObject({ outcome: { record_key: rubric } })
  })

  it.each([
    [{ evidence_level: 'opinion' }],
    [{ source: 'agent' }],
    [{ blind: 'yes' }],
    [{ labeler: 'two words' }],
    [{ labeler: 'reviewer@example.test' }],
    [{ labeler: 'Reviewer@Example.test' }],
    [{ labeler: `sha256:${'A'.repeat(64)}` }],
    [{ labeler: 'sha256:abc' }],
    [{ labeler: 'session:has space' }],
    [{ label: 'call me on 555-123-4567' }],
    [{ label: 'x'.repeat(121) }],
    [{ note: 'customer jane@example.com said so' }],
    [{ correction_minutes: -1 }],
    [{ recorded_at: '2026-10-03 13:00' }],
    [{ question_id: 'has spaces' }],
    [{ task: 'free text is not a field' }],
    [{ record_key: 'jev-call:00000000-0000-4000-8000-000000000099' }]
  ])('refuses an invalid field: %j', async (change) => {
    const ledger = await ledgerWith(1)
    await expect(
      appendJevOutcome(
        ledger,
        { record_key: key(1), outcome: { ...label, ...change } },
        async () => false
      )
    ).rejects.toThrow()
    expect(await readLedgerLines(join(ledger.directory, JEV_OUTCOMES_FILE))).toEqual([])
  })

  it('accepts a hashed person or a session as labeler, never a raw email', async () => {
    const ledger = await ledgerWith(1)
    const write = (labeler: string) =>
      appendJevOutcome(
        ledger,
        { record_key: key(1), outcome: { ...label, labeler } },
        async () => false
      )
    await expect(write('reviewer@example.test')).rejects.toThrow(
      'labeler must be session:<session or agent id> or sha256:'
    )
    await expect(write(REVIEWER)).resolves.toMatchObject({ outcome: { labeler: REVIEWER } })
    await expect(write('session:agent-7f3a.worker:2')).resolves.toMatchObject({
      outcome: { labeler: 'session:agent-7f3a.worker:2' }
    })
    const file = await readFile(join(ledger.directory, JEV_OUTCOMES_FILE), 'utf8')
    expect(file).not.toContain('@')
  })

  it('refuses a label recorded in the future', async () => {
    const ledger = await ledgerWith(1)
    const now = new Date('2026-10-03T12:00:00.000Z')
    await expect(
      appendJevOutcome(
        ledger,
        { record_key: key(1), outcome: { ...label, recorded_at: '2026-10-03T13:00:00Z' } },
        async () => false,
        now
      )
    ).rejects.toThrow('future')
  })
})
