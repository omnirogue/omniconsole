import { describe, expect, it, vi } from 'vitest'
import type {
  AccountSyncReadResult,
  AccountSyncWriteArgs,
  AccountSyncWriteResult
} from './account-sync-types'
import {
  parseSessionHostSyncDoc,
  sessionHostSyncDocKey,
  sessionHostSyncEntryId,
  type SessionHostSyncEntry
} from './session-host-sync-doc'
import {
  FIXTURE_FUTURE_ENTRY,
  FIXTURE_FUTURE_ENTRY_ID,
  FIXTURE_FUTURE_STEWARD_DOC,
  FIXTURE_SESSION_DIGEST
} from './session-host-sync-fixtures'
import type { HostSyncIngest } from './session-organization-host-sync'
import { createStewardSync, type StewardSyncState } from './steward-account-sync'

const ME = '0000beef'
const OTHER = '0000aaaa'
const FOLDERS_DOC = `omni-ide.sync.d.${OTHER}.s.0`

function account(prefs: Record<string, unknown> = {}, refuse?: (key: string) => boolean) {
  return {
    prefs,
    read: vi.fn(async (): Promise<AccountSyncReadResult> => ({
      ok: true,
      user: 'user_sal',
      prefs: { ...prefs }
    })),
    write: vi.fn(async (args: AccountSyncWriteArgs): Promise<AccountSyncWriteResult> => {
      if (refuse?.(args.key)) {
        return { ok: false, message: 'omnios answered HTTP 503.' }
      }
      prefs[args.key] = JSON.parse(JSON.stringify(args.value))
      return { ok: true }
    })
  }
}

function outbox(entries: SessionHostSyncEntry[]) {
  let items = entries.map((entry, index) => ({
    id: sessionHostSyncEntryId(entry),
    seq: index + 1,
    entry: entry as unknown
  }))
  return {
    pending: () => [...items],
    ack: vi.fn((delivered: readonly { id: string; seq: number }[]) => {
      items = items.filter(
        (item) => !delivered.some((done) => done.id === item.id && done.seq === item.seq)
      )
    }),
    size: () => items.length
  }
}

const hist = (op: string, at: number): SessionHostSyncEntry => ({
  k: 'hist',
  s: FIXTURE_SESSION_DIGEST,
  op,
  ch: 'move',
  by: 'app/steward',
  at
})

function sync(shared: ReturnType<typeof account>, queue: ReturnType<typeof outbox>) {
  const states = new Map<string, StewardSyncState>([['user_sal', { device: ME, docs: 1 }]])
  const ingested: HostSyncIngest[] = []
  const engine = createStewardSync({
    read: shared.read,
    write: shared.write,
    outbox: queue,
    state: {
      load: (user) => states.get(user) ?? null,
      save: (user, state) => states.set(user, state)
    },
    newDevice: () => ME,
    ingest: async (input) => void ingested.push(input)
  })
  return { engine, ingested }
}

describe('steward account sync', () => {
  it('publishes the outbox into this computer’s own `t` documents only, then empties it', async () => {
    const theirs = {
      v: 1,
      s: { [FIXTURE_SESSION_DIGEST]: { f: ['11111111-1111-4111-8111-111111111111', 5] } }
    }
    const shared = account({ [FOLDERS_DOC]: theirs })
    const queue = outbox([hist('op-1', 10), hist('op-2', 20)])
    const { engine, ingested } = sync(shared, queue)
    const pass = await engine.run()
    expect(pass).toMatchObject({ status: 'synced', published: 2, written: 1 })
    expect(shared.write.mock.calls.map(([args]) => args.key)).toEqual([
      sessionHostSyncDocKey(ME, 0)
    ])
    expect(shared.prefs[FOLDERS_DOC]).toEqual(theirs)
    const doc = parseSessionHostSyncDoc(shared.prefs[sessionHostSyncDocKey(ME, 0)])
    expect(doc.status === 'read' && Object.keys(doc.doc.entries).sort()).toEqual([
      'hist:op-1',
      'hist:op-2'
    ])
    expect(queue.size()).toBe(0)
    // Folder stamps from every computer come back for revocations.
    expect(ingested[0]!.placements?.get(FIXTURE_SESSION_DIGEST)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      5
    ])
    // Nothing new: nothing written.
    shared.write.mockClear()
    await engine.run()
    expect(shared.write).not.toHaveBeenCalled()
  })

  it('keeps entries of kinds it does not know in its own document, and never touches a newer one', async () => {
    const mine = sessionHostSyncDocKey(ME, 0)
    const shared = account({
      [mine]: { v: 1, e: { [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY } },
      [sessionHostSyncDocKey(OTHER, 0)]: FIXTURE_FUTURE_STEWARD_DOC
    })
    const { engine } = sync(shared, outbox([hist('op-1', 10)]))
    await engine.run()
    const doc = parseSessionHostSyncDoc(shared.prefs[mine])
    expect(doc.status === 'read' && doc.doc.opaque).toEqual({
      [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY
    })
    expect(shared.prefs[sessionHostSyncDocKey(OTHER, 0)]).toEqual(FIXTURE_FUTURE_STEWARD_DOC)

    const held = account({ [mine]: FIXTURE_FUTURE_STEWARD_DOC })
    const queue = outbox([hist('op-1', 10)])
    const pass = await sync(held, queue).engine.run()
    expect(pass).toMatchObject({ status: 'held-by-newer' })
    expect(held.write).not.toHaveBeenCalled()
    expect(queue.size()).toBe(1)
  })

  it('keeps the outbox when a write is refused, and hears other computers’ entries', async () => {
    const other: SessionHostSyncEntry = {
      k: 'rev',
      s: FIXTURE_SESSION_DIGEST,
      f: 'placement',
      op: 'mac-1',
      why: 'person/sidebar',
      at: 30
    }
    const shared = account(
      {
        [sessionHostSyncDocKey(OTHER, 0)]: { v: 1, e: { [sessionHostSyncEntryId(other)]: other } }
      },
      (key) => key.includes(ME)
    )
    const queue = outbox([hist('op-1', 10)])
    const { engine, ingested } = sync(shared, queue)
    expect(await engine.run()).toMatchObject({ status: 'synced', published: 0, written: 0 })
    expect(queue.size()).toBe(1)
    expect(ingested[0]!.entries).toEqual([other])
  })
})
