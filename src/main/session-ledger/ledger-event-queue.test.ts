import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEDGER_BATCH_MAX_BYTES,
  LEDGER_BATCH_MAX_EVENTS,
  type LedgerBatchEnvelope,
  type LedgerEventBatch
} from '../../shared/session-ledger-contract'
import {
  LEDGER_FLUSH_INTERVAL_MS,
  LEDGER_REJECTED_MAX_ATTEMPTS,
  LEDGER_WARN_INTERVAL_MS,
  LedgerEventQueue,
  type LedgerEventQueueDeps,
  type LedgerSendResult,
  type LedgerSpillStore
} from './ledger-event-queue'
import { boundSpill, LEDGER_SPILL_MAX_BYTES, type SpilledBatch } from './ledger-spill-file'

const ENVELOPE: LedgerBatchEnvelope = {
  ledger_id: 'als_0123456789abcdef01234567',
  attempt_id: 'att_0123456789abcdef',
  app: 'omni-ide',
  agent: 'claude',
  started_at: '2026-09-13T00:00:00.000Z'
}

function memorySpill(): LedgerSpillStore & { value: unknown; quarantined: string | null } {
  const store = {
    value: null as unknown,
    read: () => store.value,
    write: (value: unknown) => {
      store.value = value
    },
    remove: () => {
      store.value = null
    },
    quarantine: (reason: string) => {
      store.quarantined = reason
      store.value = null
    },
    quarantined: null as string | null
  }
  return store
}

function sender(results: LedgerSendResult[] = []) {
  const sent: LedgerEventBatch[] = []
  const accounts: string[] = []
  const send = vi.fn(
    async (batch: LedgerEventBatch, account: string): Promise<LedgerSendResult> => {
      sent.push(structuredClone(batch))
      accounts.push(account)
      return results.shift() ?? { ok: true }
    }
  )
  return { send, sent, accounts }
}

const ACCOUNT_A = 'principal-a'
const ACCOUNT_B = 'principal-b'

/** Every queue in these tests runs signed in as A unless a test says otherwise. */
function queueUnder(
  deps: Omit<LedgerEventQueueDeps, 'principal'>,
  account: string | null = ACCOUNT_A
) {
  return new LedgerEventQueue({ principal: () => account, ...deps })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ledger event queue', () => {
  it('batches ordinary events and flushes them within the interval', async () => {
    const { send, sent } = sender()
    const queue = queueUnder({ send })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'bash', target: 'git' } })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]?.events.map((event) => event.seq)).toEqual([1, 2])
    expect(sent[0]).not.toHaveProperty('employee_id')
  })

  it.each(['session_start', 'attempt_start', 'stop'] as const)(
    'flushes %s immediately',
    async (kind) => {
      const { send } = sender()
      const queue = queueUnder({ send })
      const event =
        kind === 'session_start'
          ? { kind, detail: { cwd_kind: 'repo' as const } }
          : kind === 'attempt_start'
            ? { kind, detail: { reason: 'resume' as const } }
            : { kind, detail: { reason: 'exit' as const } }
      queue.enqueue(ENVELOPE, event)
      await vi.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledTimes(1)
    }
  )

  it('coalesces file writes per path within a batch, keeping the newest', async () => {
    const { send, sent } = sender()
    const queue = queueUnder({ send })
    queue.enqueue(ENVELOPE, { kind: 'file_write', detail: { path: 'src/a.ts', op: 'create' } })
    queue.enqueue(ENVELOPE, { kind: 'file_write', detail: { path: 'src/b.ts', op: 'edit' } })
    queue.enqueue(ENVELOPE, { kind: 'file_write', detail: { path: 'src/a.ts', op: 'edit' } })
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(sent[0]?.events.map((event) => [event.seq, event.detail])).toEqual([
      [2, { path: 'src/b.ts', op: 'edit' }],
      [3, { path: 'src/a.ts', op: 'edit' }]
    ])
  })

  it('never holds more than the contract maximum, dropping expendable events first', () => {
    const { send } = sender([{ ok: false, reason: 'offline' }])
    const queue = queueUnder({ send })
    queue.enqueue(ENVELOPE, { kind: 'session_start', detail: { cwd_kind: 'repo' } })
    for (let index = 0; index < LEDGER_BATCH_MAX_EVENTS + 40; index += 1) {
      queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: `t${index}` } })
    }
    expect(queue.pendingEventCount()).toBeLessThanOrEqual(LEDGER_BATCH_MAX_EVENTS)
  })

  it('spills on failure and drains the spill at the next start', async () => {
    const spill = memorySpill()
    const offline = sender([{ ok: false, reason: 'offline' }])
    const warn = vi.fn()
    const first = queueUnder({ send: offline.send, spill, warn })
    first.enqueue(ENVELOPE, { kind: 'session_start', detail: { cwd_kind: 'repo' } })
    first.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'bash', target: 'pnpm' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(offline.send).toHaveBeenCalledTimes(1)
    expect(first.pendingEventCount()).toBe(2)
    expect(spill.value).toMatchObject({ version: 2 })
    expect(warn).toHaveBeenCalledTimes(1)

    const online = sender()
    const second = queueUnder({ send: online.send, spill })
    await second.drainSpill()
    expect(online.send).toHaveBeenCalledTimes(1)
    expect(online.sent[0]?.events.map((event) => event.kind)).toEqual([
      'session_start',
      'tool_call'
    ])
    expect(spill.value).toBeNull()
  })

  it('holds — never drops — a bound batch the transport answers signed-out for', async () => {
    // Why: the token lapsing while the principal is still A is a transient; A's stop must survive it.
    const spill = memorySpill()
    const { send, sent } = sender([{ ok: false, reason: 'signed-out' }])
    const queue = queueUnder({ send, spill })
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.pendingEventCount()).toBe(1)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.account).toBe(ACCOUNT_A)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(2)
    expect(queue.pendingEventCount()).toBe(0)
  })

  it('ships a start or stop queued during backoff at once — once per window — and resumes backoff on failure', async () => {
    const { send, sent } = sender([
      { ok: false, reason: 'offline' },
      { ok: false, reason: 'offline' }
    ])
    const queue = queueUnder({ send })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(sent).toHaveLength(1)

    // Backing off (30 s): a stop does not wait for the window.
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.events.map((event) => event.kind)).toEqual(['tool_call', 'stop'])

    // That attempt failed too: the next immediate event within the new window waits its turn.
    const other = { ...ENVELOPE, ledger_id: 'als_bbbbbbbbbbbbbbbbbbbbbbbb' }
    queue.enqueue(other, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.length).toBeGreaterThanOrEqual(4)
    expect(queue.pendingEventCount()).toBe(0)
  })

  it('never lets one refused batch block other rows or start a backoff', async () => {
    const rows = [
      'als_aaaaaaaaaaaaaaaaaaaaaaaa',
      'als_bbbbbbbbbbbbbbbbbbbbbbbb',
      'als_cccccccccccccccccccccccc'
    ]
    const send = vi.fn(async (batch: LedgerEventBatch): Promise<LedgerSendResult> =>
      batch.ledger_id === rows[0] ? { ok: false, reason: 'rejected' } : { ok: true }
    )
    const sent = (): string[] => send.mock.calls.map(([batch]) => batch.ledger_id)
    const queue = queueUnder({ send })
    for (const ledgerId of rows) {
      queue.enqueue(
        { ...ENVELOPE, ledger_id: ledgerId },
        { kind: 'tool_call', detail: { tool: 'Read' } }
      )
    }
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    // The poison batch did not stop B and C in the same cycle.
    expect(sent()).toEqual(rows)
    // Nor does it delay a later row's immediate start: no backoff is in force.
    queue.enqueue(
      { ...ENVELOPE, ledger_id: 'als_dddddddddddddddddddddddd' },
      { kind: 'session_start', detail: { cwd_kind: 'repo' } }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(sent().at(-1)).toBe('als_dddddddddddddddddddddddd')
    // The refused batch retries behind everything else and is then given up.
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS * 3)
    expect(sent().filter((id) => id === rows[0])).toHaveLength(LEDGER_REJECTED_MAX_ATTEMPTS)
    expect(queue.pendingEventCount()).toBe(0)
  })

  it('keeps the spill through an outage across a restart until every batch is delivered', async () => {
    const spill = memorySpill()
    const offline = sender([{ ok: false, reason: 'offline' }])
    const first = queueUnder({ send: offline.send, spill })
    first.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(spill.value).not.toBeNull()

    // Restart during the outage: the drain's flush fails and the spill is still there.
    const stillOffline = sender([
      { ok: false, reason: 'offline' },
      { ok: false, reason: 'offline' }
    ])
    const second = queueUnder({ send: stillOffline.send, spill })
    await second.drainSpill()
    expect(stillOffline.send).toHaveBeenCalledTimes(1)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.batch.events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.batch.events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(second.pendingEventCount()).toBe(0)
    expect(spill.value).toBeNull()
  })

  it('spills a batch a failed send left over even while a later batch is still in flight', async () => {
    const spill = memorySpill()
    const rows = ['als_aaaaaaaaaaaaaaaaaaaaaaaa', 'als_bbbbbbbbbbbbbbbbbbbbbbbb']
    let releaseSecond: () => void = () => {}
    const send = vi.fn(
      (batch: LedgerEventBatch) =>
        new Promise<LedgerSendResult>((resolve) => {
          if (batch.ledger_id === rows[0]) {
            resolve({ ok: false, reason: 'principal-mismatch' })
          } else {
            releaseSecond = () => resolve({ ok: true })
          }
        })
    )
    const queue = queueUnder({ send, spill })
    queue.enqueue({ ...ENVELOPE, ledger_id: rows[0] }, { kind: 'stop', detail: { reason: 'quit' } })
    queue.enqueue({ ...ENVELOPE, ledger_id: rows[1] }, { kind: 'stop', detail: { reason: 'quit' } })
    const flushed = queue.flush()
    await vi.advanceTimersByTimeAsync(0)
    // The first batch failed and the second is awaiting: a quit now must spill the first.
    const done = queue.shutdown(50)
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(
      (spill.value as { batches: SpilledBatch[] }).batches.map((b) => b.batch.ledger_id)
    ).toEqual(expect.arrayContaining([rows[0], rows[1]]))
    releaseSecond()
    await flushed
  })

  it('gives up a console-rejected batch only after bounded retries, and says so', async () => {
    const warn = vi.fn()
    const { send, sent } = sender(
      Array.from({ length: LEDGER_REJECTED_MAX_ATTEMPTS + 2 }, () => ({
        ok: false as const,
        reason: 'rejected' as const
      }))
    )
    const queue = queueUnder({ send, warn })
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.pendingEventCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(sent).toHaveLength(LEDGER_REJECTED_MAX_ATTEMPTS)
    expect(queue.pendingEventCount()).toBe(0)
    expect(warn.mock.calls.some(([message]) => String(message).includes('giving up'))).toBe(true)
  })

  it('sends an oversize batch as consecutive payloads within the byte cap, in order', async () => {
    const { send, sent } = sender()
    const queue = queueUnder({ send })
    for (let index = 0; index < 200; index += 1) {
      queue.enqueue(ENVELOPE, {
        kind: 'file_write',
        detail: { path: `${String(index).padStart(4, '0')}/${'p'.repeat(290)}`, op: 'edit' }
      })
    }
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(sent.length).toBeGreaterThan(1)
    for (const batch of sent) {
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(LEDGER_BATCH_MAX_BYTES)
    }
    const seqs = sent.flatMap((batch) => batch.events.map((event) => event.seq))
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, index) => index + 1))
    expect(queue.pendingEventCount()).toBe(0)
  })

  it('requeues the batches a failed run could not deliver in their original order', async () => {
    const rows = [
      'als_aaaaaaaaaaaaaaaaaaaaaaaa',
      'als_bbbbbbbbbbbbbbbbbbbbbbbb',
      'als_cccccccccccccccccccccccc'
    ]
    const { send, sent } = sender([{ ok: false, reason: 'offline' }])
    const queue = queueUnder({ send })
    for (const ledgerId of rows) {
      queue.enqueue(
        { ...ENVELOPE, ledger_id: ledgerId },
        { kind: 'tool_call', detail: { tool: 'Read' } }
      )
    }
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(sent.map((batch) => batch.ledger_id)).toEqual([rows[0]])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.map((batch) => batch.ledger_id)).toEqual([rows[0], ...rows])
  })

  it("sends every live pane's stop{quit} at shutdown, not only the first", async () => {
    const rows = [
      'als_aaaaaaaaaaaaaaaaaaaaaaaa',
      'als_bbbbbbbbbbbbbbbbbbbbbbbb',
      'als_cccccccccccccccccccccccc'
    ]
    const { send, sent } = sender()
    const queue = queueUnder({ send })
    // Row 1's stop starts a run at once; rows 2 and 3 enqueue while it is in flight.
    for (const ledgerId of rows) {
      queue.enqueue(
        { ...ENVELOPE, ledger_id: ledgerId },
        { kind: 'stop', detail: { reason: 'quit' } }
      )
    }
    const done = queue.shutdown(2_000)
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(sent.map((batch) => batch.ledger_id)).toEqual(rows)
    expect(queue.pendingEventCount()).toBe(0)
  })

  it('spills the stops the quit budget did not reach', async () => {
    const spill = memorySpill()
    const rows = ['als_aaaaaaaaaaaaaaaaaaaaaaaa', 'als_bbbbbbbbbbbbbbbbbbbbbbbb']
    const send = vi.fn(() => new Promise<LedgerSendResult>(() => {}))
    const queue = queueUnder({ send, spill })
    for (const ledgerId of rows) {
      queue.enqueue(
        { ...ENVELOPE, ledger_id: ledgerId },
        { kind: 'stop', detail: { reason: 'quit' } }
      )
    }
    const done = queue.shutdown(100)
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(
      (spill.value as { batches: SpilledBatch[] }).batches.map((b) => b.batch.ledger_id)
    ).toEqual(rows)
  })

  it('never removes the quit spill from a send that completes after shutdown', async () => {
    const spill = memorySpill()
    let release: () => void = () => {}
    const send = vi.fn(
      () =>
        new Promise<LedgerSendResult>((resolve) => {
          release = () => resolve({ ok: true })
        })
    )
    const queue = queueUnder({ send, spill })
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'quit' } })
    const done = queue.shutdown(100)
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(spill.value).not.toBeNull()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(spill.value).not.toBeNull()
  })

  it('warns at most once per ten minutes', async () => {
    const warn = vi.fn()
    // Why: stays offline for the whole window, so the throttle — not a recovery — is what is measured.
    const { send } = sender(
      Array.from({ length: 40 }, () => ({ ok: false as const, reason: 'offline' as const }))
    )
    const queue = queueUnder({ send, warn })
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(warn).toHaveBeenCalledTimes(1)
    // Why: retries back off to five minutes, so the next failure after the window lands ≤ 15 min in.
    await vi.advanceTimersByTimeAsync(LEDGER_WARN_INTERVAL_MS + 5 * 60_000)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('resolves a quit within the teardown budget even when the send hangs, spilling what is left', async () => {
    const spill = memorySpill()
    const send = vi.fn(() => new Promise<LedgerSendResult>(() => {}))
    const queue = queueUnder({ send, spill })
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'quit' } })
    let settled = false
    const shutdown = queue.shutdown(2_000).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await shutdown
    expect(settled).toBe(true)
    const batches = (spill.value as { batches: SpilledBatch[] }).batches
    expect(batches[0]?.account).toBe(ACCOUNT_A)
    expect(batches[0]?.batch.events.map((event) => event.kind)).toEqual(['stop'])
  })

  it("holds ownerless events and releases them only when the row is confirmed to be the signed-in person's", async () => {
    let account: string | null = null
    let rowOwner: string | null = null
    const spill = memorySpill()
    const { send, sent, accounts } = sender()
    const claimOwner = vi.fn((_envelope: unknown, candidate: string) => rowOwner === candidate)
    const queue = new LedgerEventQueue({ send, spill, principal: () => account, claimOwner })
    queue.enqueue(ENVELOPE, { kind: 'session_start', detail: { cwd_kind: 'repo' } })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(send).not.toHaveBeenCalled()
    expect(queue.pendingEventCount()).toBe(2)
    // The held state survives a quit: the spill records the batch as ownerless.
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.account).toBeNull()

    // Whoever signs in next does not get them: the row has no owner.
    account = ACCOUNT_B
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS * 4)
    expect(claimOwner).toHaveBeenCalledWith(
      expect.objectContaining({ ledger_id: ENVELOPE.ledger_id }),
      ACCOUNT_B
    )
    expect(send).not.toHaveBeenCalled()
    expect(queue.pendingEventCount()).toBe(2)

    // Only a row that carries this owner releases them (the read-only comparison answers yes).
    rowOwner = ACCOUNT_B
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(accounts).toEqual([ACCOUNT_B])
    expect(sent[0]?.events.map((event) => event.seq)).toEqual([1, 2])
    expect(queue.pendingEventCount()).toBe(0)
    expect(spill.value).toBeNull()
  })

  it("keeps holding ownerless events when the row is not the signed-in person's", async () => {
    let account: string | null = null
    const spill = memorySpill()
    const { send } = sender()
    const queue = new LedgerEventQueue({
      send,
      spill,
      principal: () => account,
      claimOwner: () => false
    })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    account = ACCOUNT_B
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS * 4)
    expect(send).not.toHaveBeenCalled()
    expect(queue.pendingEventCount()).toBe(1)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.account).toBeNull()
  })

  it("merges ownerless events ahead of the same row's later events once claimed", async () => {
    let account: string | null = null
    const { send, sent } = sender()
    const queue = new LedgerEventQueue({ send, principal: () => account, claimOwner: () => true })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    account = ACCOUNT_A
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Write' } })
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.events.map((event) => event.seq)).toEqual([1, 2])
  })

  it("does not evict another account's held batch to make room for the current one", async () => {
    let account: string | null = ACCOUNT_A
    const { send, sent } = sender([{ ok: false, reason: 'offline' }])
    const queue = new LedgerEventQueue({ send, principal: () => account })
    const held = { ...ENVELOPE, ledger_id: 'als_aaaaaaaaaaaaaaaaaaaaaaaa' }
    queue.enqueue(held, { kind: 'session_start', detail: { cwd_kind: 'repo' } })
    for (let index = 0; index < 20; index += 1) {
      queue.enqueue(held, { kind: 'tool_call', detail: { tool: `a${index}` } })
    }
    queue.enqueue(held, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    const heldCount = queue.pendingEventCount()
    expect(heldCount).toBe(22)

    account = ACCOUNT_B
    for (let index = 0; index < LEDGER_BATCH_MAX_EVENTS + 40; index += 1) {
      queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: `b${index}` } })
    }
    // B's own budget is capped; A's held events sit outside it, untouched.
    expect(queue.pendingEventCount()).toBe(LEDGER_BATCH_MAX_EVENTS + 22)

    // A signs back in: every one of A's events is still there, in order.
    account = ACCOUNT_A
    await vi.advanceTimersByTimeAsync(30_000)
    const delivered = sent.findLast((batch) => batch.ledger_id === held.ledger_id)
    expect(delivered?.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 22 }, (_, index) => index + 1)
    )
    expect(queue.pendingEventCount()).toBe(LEDGER_BATCH_MAX_EVENTS)
  })

  it("holds foreign and ownerless events outside the signed-in account's budget, never its start/stop", () => {
    const { send } = sender()
    const queue = queueUnder({ send }, null)
    const orphan = { ...ENVELOPE, ledger_id: 'als_aaaaaaaaaaaaaaaaaaaaaaaa' }
    for (let index = 0; index < LEDGER_BATCH_MAX_EVENTS + 50; index += 1) {
      queue.enqueue(orphan, { kind: 'tool_call', detail: { tool: `o${index}` } })
    }
    expect(queue.pendingEventCount()).toBe(LEDGER_BATCH_MAX_EVENTS)
    // A's row (still signed out, so nothing can be sent) is queued under A's own binding.
    queue.enqueue(ENVELOPE, { kind: 'session_start', detail: { cwd_kind: 'repo' } }, ACCOUNT_A)
    for (let index = 0; index < 10; index += 1) {
      queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: `a${index}` } }, ACCOUNT_A)
    }
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } }, ACCOUNT_A)
    // A's twelve events are all there: the two hundred ownerless ones cost A nothing.
    expect(queue.pendingEventCount()).toBe(LEDGER_BATCH_MAX_EVENTS + 12)
  })

  it('gives up ownerless batches whose row no longer exists, or that aged out, once and loudly', async () => {
    let account: string | null = null
    const warn = vi.fn()
    const spill = memorySpill()
    const known = new Set([ENVELOPE.ledger_id])
    const { send, sent } = sender()
    const queue = new LedgerEventQueue({
      send,
      spill,
      warn,
      principal: () => account,
      claimOwner: () => false,
      rowKnown: (envelope) => known.has(envelope.ledger_id)
    })
    const orphan = { ...ENVELOPE, ledger_id: 'als_aaaaaaaaaaaaaaaaaaaaaaaa' }
    queue.enqueue(orphan, { kind: 'stop', detail: { reason: 'close' } })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS)
    expect(queue.pendingEventCount()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(
      (spill.value as { batches: SpilledBatch[] }).batches.map((b) => b.batch.ledger_id)
    ).toEqual([ENVELOPE.ledger_id])
    // The survivor waits (idle flushes do not rewrite the spill) until it ages out.
    const written = vi.spyOn(spill, 'write')
    await vi.advanceTimersByTimeAsync(LEDGER_FLUSH_INTERVAL_MS * 10)
    expect(written).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(queue.pendingEventCount()).toBe(0)
    expect(spill.value).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})

describe('spill draining', () => {
  it('sets an unreadable spill aside instead of deleting it, and rewrites before sending', async () => {
    const spill = memorySpill()
    const quarantine = vi.fn()
    spill.value = {
      version: 1,
      batches: [{ account: ACCOUNT_A, batch: { ...ENVELOPE, events: [] } }]
    }
    const { send } = sender()
    const queue = queueUnder({ send, spill: { ...spill, quarantine } })
    await queue.drainSpill()
    expect(quarantine).toHaveBeenCalledWith('unreadable')
    expect(send).not.toHaveBeenCalled()

    // B3: a read that throws is not "empty" — the file is set aside, never overwritten or removed.
    const throwing = {
      ...memorySpill(),
      read: (): unknown => {
        throw new Error('EIO')
      }
    }
    throwing.value = 'real batches'
    const removeSpy = vi.spyOn(throwing, 'remove')
    const writeSpy = vi.spyOn(throwing, 'write')
    const quarantineSpy = vi.spyOn(throwing, 'quarantine')
    const warn = vi.fn()
    const blocked = queueUnder({ send, spill: throwing, warn })
    await blocked.drainSpill()
    expect(quarantineSpy).toHaveBeenCalledWith('unreadable')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spill read failed'))
    expect(removeSpy).not.toHaveBeenCalled()
    expect(writeSpy).not.toHaveBeenCalled()

    // If the file cannot even be set aside, nothing this run writes or removes it.
    const stuck = {
      ...memorySpill(),
      read: (): unknown => {
        throw new Error('EIO')
      },
      quarantine: () => {
        throw new Error('EPERM')
      }
    }
    const stuckRemove = vi.spyOn(stuck, 'remove')
    const stuckWrite = vi.spyOn(stuck, 'write')
    const offlineSender = sender([{ ok: false, reason: 'offline' }])
    const guarded = queueUnder({ send: offlineSender.send, spill: stuck, warn })
    await guarded.drainSpill()
    guarded.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(stuckWrite).not.toHaveBeenCalled()
    expect(stuckRemove).not.toHaveBeenCalled()

    const writes: unknown[] = []
    const failing = sender([{ ok: false, reason: 'offline' }])
    const journal: LedgerSpillStore = {
      read: () => ({
        version: 2,
        batches: [
          {
            account: ACCOUNT_A,
            batch: {
              ...ENVELOPE,
              events: [{ seq: 1, kind: 'stop', at: 't', detail: { reason: 'quit' } }]
            }
          }
        ]
      }),
      write: (value) => writes.push(value),
      remove: () => writes.push('removed'),
      quarantine: () => writes.push('quarantined')
    }
    await queueUnder({ send: failing.send, spill: journal }).drainSpill()
    // The merged state is written before the send is attempted; the old file is never removed first.
    expect(writes[0]).toMatchObject({ version: 2 })
    expect(writes).not.toContain('removed')
  })
})

describe('account binding mid-flush', () => {
  const SECOND = { ...ENVELOPE, ledger_id: 'als_bbbbbbbbbbbbbbbbbbbbbbbb' }

  it('does not send the next batch when the account flips while the first is in flight', async () => {
    let account: string | null = ACCOUNT_A
    const sent: string[] = []
    let releaseFirst: () => void = () => {}
    const send = vi.fn(
      (batch: LedgerEventBatch, boundTo: string) =>
        new Promise<LedgerSendResult>((resolve) => {
          sent.push(`${batch.ledger_id}:${boundTo}`)
          releaseFirst = () => resolve({ ok: true })
        })
    )
    const queue = new LedgerEventQueue({ send, principal: () => account })
    queue.enqueue(ENVELOPE, { kind: 'tool_call', detail: { tool: 'Read' } })
    queue.enqueue(SECOND, { kind: 'tool_call', detail: { tool: 'Read' } })
    const flushed = queue.flush()
    expect(sent).toEqual([`${ENVELOPE.ledger_id}:${ACCOUNT_A}`])

    account = ACCOUNT_B
    releaseFirst()
    await flushed
    expect(sent).toHaveLength(1)
    expect(queue.pendingEventCount()).toBe(1)

    // B's own flush still leaves A's batch alone.
    await queue.flush()
    expect(sent).toHaveLength(1)

    account = ACCOUNT_A
    const secondFlush = queue.flush()
    releaseFirst()
    await secondFlush
    expect(sent).toEqual([`${ENVELOPE.ledger_id}:${ACCOUNT_A}`, `${SECOND.ledger_id}:${ACCOUNT_A}`])
    expect(queue.pendingEventCount()).toBe(0)
  })

  it('holds — never drops — a batch the transport refused for a principal mismatch', async () => {
    const spill = memorySpill()
    const { send, sent } = sender([{ ok: false, reason: 'principal-mismatch' }])
    const queue = queueUnder({ send, spill })
    queue.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'exit' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)
    expect(queue.pendingEventCount()).toBe(1)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.account).toBe(ACCOUNT_A)
    await queue.flush()
    expect(sent).toHaveLength(2)
    expect(queue.pendingEventCount()).toBe(0)
  })
})

describe('account binding across restarts', () => {
  it('flushes a spill only while the account it was queued under is signed in', async () => {
    const spill = memorySpill()
    const offline = sender([{ ok: false, reason: 'offline' }])
    const first = queueUnder({ send: offline.send, spill }, ACCOUNT_A)
    first.enqueue(ENVELOPE, { kind: 'session_start', detail: { cwd_kind: 'repo' } })
    await vi.advanceTimersByTimeAsync(0)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.account).toBe(ACCOUNT_A)

    // Restart signed in as B: nothing is sent and A's batch is retained on disk.
    const asB = sender()
    const second = queueUnder({ send: asB.send, spill }, ACCOUNT_B)
    await second.drainSpill()
    expect(asB.send).not.toHaveBeenCalled()
    expect(second.pendingEventCount()).toBe(1)
    expect((spill.value as { batches: SpilledBatch[] }).batches[0]?.account).toBe(ACCOUNT_A)

    // B's own events go out; A's stay held.
    second.enqueue(
      { ...ENVELOPE, ledger_id: 'als_aaaaaaaaaaaaaaaaaaaaaaaa' },
      {
        kind: 'stop',
        detail: { reason: 'exit' }
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(asB.sent.map((batch) => batch.ledger_id)).toEqual(['als_aaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(second.pendingEventCount()).toBe(1)

    // Restart signed in as A again: the held batch is delivered.
    const asA = sender()
    const third = queueUnder({ send: asA.send, spill }, ACCOUNT_A)
    await third.drainSpill()
    expect(asA.sent.map((batch) => batch.events[0]?.kind)).toEqual(['session_start'])
    expect(spill.value).toBeNull()
  })

  it('flushes normally after a same-account restart', async () => {
    const spill = memorySpill()
    const offline = sender([{ ok: false, reason: 'offline' }])
    const first = queueUnder({ send: offline.send, spill }, ACCOUNT_A)
    first.enqueue(ENVELOPE, { kind: 'stop', detail: { reason: 'quit' } })
    await vi.advanceTimersByTimeAsync(0)
    const again = sender()
    const second = queueUnder({ send: again.send, spill }, ACCOUNT_A)
    await second.drainSpill()
    expect(again.send).toHaveBeenCalledTimes(1)
  })
})

describe('spill bounding', () => {
  it('drops oldest expendable events first and keeps start/stop', () => {
    const big = 'x'.repeat(150)
    const events: LedgerEventBatch['events'] = [
      { seq: 1, kind: 'session_start', at: 't', detail: { cwd_kind: 'repo' } },
      ...Array.from({ length: 8_000 }, (_, index) => ({
        seq: index + 2,
        kind: 'tool_call' as const,
        at: 't',
        detail: { tool: 'bash', target: big }
      })),
      { seq: 9_000, kind: 'stop', at: 't', detail: { reason: 'exit' } }
    ]
    const bounded = boundSpill([{ account: ACCOUNT_A, batch: { ...ENVELOPE, events } }])
    const kinds = bounded[0]?.batch.events.map((event) => event.kind) ?? []
    expect(Buffer.byteLength(JSON.stringify({ version: 2, batches: bounded }))).toBeLessThanOrEqual(
      LEDGER_SPILL_MAX_BYTES
    )
    expect(kinds[0]).toBe('session_start')
    expect(kinds.at(-1)).toBe('stop')
    expect(kinds.length).toBeLessThan(events.length)
  })
})
