import { describe, expect, it, vi } from 'vitest'
import type {
  AccountSyncReadResult,
  AccountSyncWriteArgs,
  AccountSyncWriteResult
} from '../../../../shared/account-sync-types'
import {
  mayRewriteSessionHostSyncDoc,
  parseSessionHostSyncDoc,
  sessionHostSyncDocKey,
  sessionHostSyncEntryId
} from '../../../../shared/session-host-sync-doc'
import {
  FIXTURE_FUTURE_ENTRY,
  FIXTURE_FUTURE_ENTRY_ID,
  FIXTURE_FUTURE_STEWARD_DOC,
  FIXTURE_SYNC_ENTRIES,
  fixtureStewardDocValue
} from '../../../../shared/session-host-sync-fixtures'
import type { HostSyncIngest } from '../../../../shared/session-organization-host-sync'
import { createStewardSync } from '../../../../shared/steward-account-sync'
import { localKeyDigest } from '../../../../shared/account-sync-session-keys'
import { emptySessionFolderMetadata, type SessionFolderMetadata } from '@/lib/session-folders'
import { createSessionAccountSync } from './session-sync-engine'

// Why the real engine: it is exactly what released clients run for folders and sessions, so this
// proves an old client leaves the steward kind (and any unknown kind) alone.
const CLIENTS = '11111111-1111-4111-8111-111111111111'
const ACME = '22222222-2222-4222-8222-222222222222'
const SESSION = JSON.stringify(['local', 'provider', 'repo::/work/app\0claude\0claude\0session-1'])
const NEW_DEVICE = '0000beef'
const FUTURE_DEVICE = '0000cafe'
const STEWARD_KEY = sessionHostSyncDocKey(NEW_DEVICE, 0)
const FUTURE_STEWARD_KEY = sessionHostSyncDocKey(FUTURE_DEVICE, 0)
const UNKNOWN_KIND_KEY = `omni-ide.sync.d.${NEW_DEVICE}.u.0`

function account() {
  const prefs: Record<string, unknown> = {}
  return {
    prefs,
    read: vi.fn(async (): Promise<AccountSyncReadResult> => ({
      ok: true,
      user: 'user_sal',
      prefs: { ...prefs }
    })),
    write: vi.fn(async (args: AccountSyncWriteArgs): Promise<AccountSyncWriteResult> => {
      prefs[args.key] = JSON.parse(JSON.stringify(args.value))
      return { ok: true as const }
    })
  }
}

function legacyComputer(shared: ReturnType<typeof account>, device: string) {
  const storage = new Map<string, string>()
  const filed = new Set<string>()
  const state = {
    metadata: emptySessionFolderMetadata() as SessionFolderMetadata,
    archived: [] as string[],
    archivedAt: {} as Record<string, number>,
    present: [SESSION],
    folderPaths: {}
  }
  const sync = createSessionAccountSync({
    read: shared.read,
    write: shared.write,
    local: {
      ready: () => true,
      scope: () => 'profile',
      input: () => ({ ...state }),
      replaceMetadata: (metadata) => {
        state.metadata = metadata
      },
      setArchived: () => {}
    },
    intent: {
      pending: () => ({
        filed: new Set(filed),
        archived: new Set(),
        folders: new Set(),
        gone: new Map()
      }),
      settle: (_scope, done) => done.filed.forEach((key) => filed.delete(key))
    },
    newDevice: () => device,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    now: () => 1_000,
    report: vi.fn()
  })
  /** A person re-filed a session here: the engine authors only what its intent journal names. */
  const refile = (key: string, folderId: string) => {
    state.metadata = {
      ...state.metadata,
      membership: { ...state.metadata.membership, [key]: folderId }
    }
    filed.add(key)
  }
  return { state, sync, refile }
}

/** A Phase 4 client's steward writer: its own `t` document only, never another computer's. */
async function newClientWritesSteward(shared: ReturnType<typeof account>) {
  if (mayRewriteSessionHostSyncDoc(shared.prefs[STEWARD_KEY])) {
    await shared.write({
      key: STEWARD_KEY,
      value: fixtureStewardDocValue(),
      expectedUser: 'user_sal'
    })
  }
  await shared.write({
    key: UNKNOWN_KIND_KEY,
    value: { v: 1, x: ['from a later build'] },
    expectedUser: 'user_sal'
  })
  await shared.write({
    key: FUTURE_STEWARD_KEY,
    value: FIXTURE_FUTURE_STEWARD_DOC,
    expectedUser: 'user_sal'
  })
}

describe('steward sync documents across client versions', () => {
  it('old → new → old: the released engine keeps its folders and leaves every newer kind untouched', async () => {
    const shared = account()
    const legacy = legacyComputer(shared, '0000aaaa')
    legacy.state.metadata = {
      version: 1,
      folders: [
        { id: CLIENTS, name: 'Clients' },
        { id: ACME, name: 'Acme', parentId: CLIENTS }
      ],
      membership: { [SESSION]: ACME }
    }
    await legacy.sync.run()
    const legacyDocs = Object.fromEntries(Object.entries(shared.prefs))
    expect(Object.keys(legacyDocs).length).toBeGreaterThan(0)

    await newClientWritesSteward(shared)
    const newerDocs = {
      [STEWARD_KEY]: shared.prefs[STEWARD_KEY],
      [UNKNOWN_KIND_KEY]: shared.prefs[UNKNOWN_KIND_KEY],
      [FUTURE_STEWARD_KEY]: shared.prefs[FUTURE_STEWARD_KEY]
    }
    // The new client never touched the old client's folder and session documents.
    for (const [key, value] of Object.entries(legacyDocs)) {
      expect(shared.prefs[key]).toEqual(value)
    }

    shared.write.mockClear()
    legacy.refile(SESSION, CLIENTS)
    await legacy.sync.run()
    const written = shared.write.mock.calls.map(([args]) => args.key)
    expect(written.length).toBeGreaterThan(0)
    expect(written.every((key) => /^omni-ide\.sync\.d\.0000aaaa\.[fs]\.\d+$/.test(key))).toBe(true)
    for (const [key, value] of Object.entries(newerDocs)) {
      expect(shared.prefs[key]).toEqual(value)
    }
    expect(legacy.state.metadata.membership).toEqual({ [SESSION]: CLIENTS })
    expect(legacy.state.metadata.folders.map((folder) => folder.name)).toEqual(['Clients', 'Acme'])

    // And the new client still reads its steward data, with the unknown entry kind intact.
    const steward = parseSessionHostSyncDoc(shared.prefs[STEWARD_KEY])
    expect(steward.status === 'read' && Object.keys(steward.doc.opaque)).toEqual([
      expect.stringMatching(/^lease:/)
    ])
  })

  it('a second legacy computer applies the folders and ignores steward documents entirely', async () => {
    const shared = account()
    await newClientWritesSteward(shared)
    const first = legacyComputer(shared, '0000aaaa')
    first.state.metadata = {
      version: 1,
      folders: [{ id: CLIENTS, name: 'Clients' }],
      membership: { [SESSION]: CLIENTS }
    }
    await first.sync.run()
    const second = legacyComputer(shared, '0000bbbb')
    await second.sync.run()
    expect(second.state.metadata.membership).toEqual({ [SESSION]: CLIENTS })
    expect(shared.prefs[STEWARD_KEY]).toEqual(fixtureStewardDocValue())
    expect(shared.prefs[FUTURE_STEWARD_KEY]).toEqual(FIXTURE_FUTURE_STEWARD_DOC)
  })

  it('a new client never overwrites a steward document a newer version of itself wrote', async () => {
    const shared = account()
    shared.prefs[STEWARD_KEY] = FIXTURE_FUTURE_STEWARD_DOC
    await newClientWritesSteward(shared)
    expect(shared.prefs[STEWARD_KEY]).toEqual(FIXTURE_FUTURE_STEWARD_DOC)
  })

  it('old → new → old with the new steward sync itself: each engine writes only its own kind', async () => {
    const shared = account()
    const legacy = legacyComputer(shared, '0000aaaa')
    legacy.state.metadata = {
      version: 1,
      folders: [
        { id: CLIENTS, name: 'Clients' },
        { id: ACME, name: 'Acme' }
      ],
      membership: { [SESSION]: ACME }
    }
    await legacy.sync.run()
    // A later build on the new client's own device left a kind this build does not know.
    shared.prefs[STEWARD_KEY] = { v: 1, e: { [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY } }
    shared.prefs[FUTURE_STEWARD_KEY] = FIXTURE_FUTURE_STEWARD_DOC
    const folderDocs = Object.fromEntries(
      Object.entries(shared.prefs).filter(([key]) => /\.[fs]\.\d+$/.test(key))
    )

    let queue = FIXTURE_SYNC_ENTRIES.map((entry, index) => ({
      id: sessionHostSyncEntryId(entry),
      seq: index + 1,
      entry: entry as unknown
    }))
    const ingested: HostSyncIngest[] = []
    const steward = createStewardSync({
      read: shared.read,
      write: shared.write,
      outbox: {
        pending: () => [...queue],
        ack: (done) => {
          queue = queue.filter((item) => !done.some((entry) => entry.id === item.id))
        }
      },
      state: { load: () => ({ device: NEW_DEVICE, docs: 1 }), save: () => {} },
      newDevice: () => NEW_DEVICE,
      ingest: async (input) => void ingested.push(input)
    })
    shared.write.mockClear()
    expect(await steward.run()).toMatchObject({
      status: 'synced',
      published: FIXTURE_SYNC_ENTRIES.length
    })
    expect(shared.write.mock.calls.map(([args]) => args.key)).toEqual([STEWARD_KEY])
    expect(queue).toEqual([])
    for (const [key, value] of Object.entries(folderDocs)) {
      expect(shared.prefs[key]).toEqual(value)
    }
    const afterNew = structuredClone(shared.prefs[STEWARD_KEY])

    shared.write.mockClear()
    legacy.refile(SESSION, CLIENTS)
    await legacy.sync.run()
    expect(
      shared.write.mock.calls.every(([args]) =>
        /^omni-ide\.sync\.d\.0000aaaa\.[fs]\.\d+$/.test(args.key)
      )
    ).toBe(true)
    expect(shared.prefs[STEWARD_KEY]).toEqual(afterNew)
    expect(shared.prefs[FUTURE_STEWARD_KEY]).toEqual(FIXTURE_FUTURE_STEWARD_DOC)
    expect(legacy.state.metadata.membership).toEqual({ [SESSION]: CLIENTS })

    // Back to the new client: its own document keeps the unknown kind; the older app's re-file
    // reaches it as a folder stamp it did not author, which is what revokes an agent's placement.
    await steward.run()
    const steward2 = parseSessionHostSyncDoc(shared.prefs[STEWARD_KEY])
    expect(steward2.status === 'read' && steward2.doc.opaque).toEqual({
      [FIXTURE_FUTURE_ENTRY_ID]: FIXTURE_FUTURE_ENTRY
    })
    const digest = localKeyDigest(SESSION)!
    expect(ingested.at(-1)!.placements?.get(digest)?.[0]).toBe(CLIENTS)

    // And a second older computer still gets the folders and ignores every steward document.
    const second = legacyComputer(shared, '0000bbbb')
    await second.sync.run()
    expect(second.state.metadata.membership).toEqual({ [SESSION]: CLIENTS })
    expect(shared.prefs[FUTURE_STEWARD_KEY]).toEqual(FIXTURE_FUTURE_STEWARD_DOC)
  })
})
