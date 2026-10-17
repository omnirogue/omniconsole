import { describe, expect, it, vi } from 'vitest'
import {
  accountSyncValueSize,
  type AccountSyncReadResult,
  type AccountSyncWriteArgs,
  type AccountSyncWriteResult
} from '../../../../shared/account-sync-types'
import {
  emptySessionFolderMetadata,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolderMetadata
} from '@/lib/session-folders'
import type { DeletedFolder, SessionOrganizationIntent } from './session-organization-intent'
import { createSessionAccountSync } from './session-sync-engine'

const CLIENTS = '11111111-1111-4111-8111-111111111111'
const ACME = '22222222-2222-4222-8222-222222222222'
const LAPTOP_CLIENTS = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'

/** The same Claude session, named from its own computer and from one paired with it. */
const sessionKey = (host: string, id = 'session-1') =>
  JSON.stringify([host, 'provider', `repo::/work/app\0claude\0claude\0${id}`])
const BIGMAC_KEY = sessionKey('local')
const LAPTOP_KEY = sessionKey('runtime:bigmac')

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

let devices = 0
const noIntent = (): SessionOrganizationIntent => ({
  filed: new Set(),
  archived: new Set(),
  folders: new Set(),
  gone: new Map()
})
type Intended = Partial<Record<'filed' | 'archived' | 'folders', string[]>> & {
  gone?: Record<string, DeletedFolder>
}

function computer(shared: ReturnType<typeof account>, present: string[], clock: { now: number }) {
  const storage = new Map<string, string>()
  const failures = { saves: 0 }
  const device = (++devices).toString(16).padStart(8, '0')
  const state = {
    metadata: emptySessionFolderMetadata() as SessionFolderMetadata,
    archived: [] as string[],
    archivedAt: {} as Record<string, number>,
    scope: 'profile',
    present,
    folderPaths: {}
  }
  const journal = noIntent()
  const report = vi.fn()
  const sync = createSessionAccountSync({
    read: shared.read,
    write: shared.write,
    local: {
      ready: () => true,
      scope: () => state.scope,
      input: () => ({ ...state }),
      replaceMetadata: (metadata) => {
        state.metadata = metadata
      },
      setArchived: (keys, archived) => {
        const next = new Set(state.archived)
        for (const key of keys) {
          if (archived) {
            next.add(key)
            state.archivedAt[key] = clock.now
          } else {
            next.delete(key)
          }
        }
        state.archived = [...next]
      }
    },
    intent: {
      pending: () => ({
        filed: new Set(journal.filed),
        archived: new Set(journal.archived),
        folders: new Set(journal.folders),
        gone: new Map(journal.gone)
      }),
      settle: (_scope, done) => {
        for (const field of ['filed', 'archived', 'folders'] as const) {
          done[field].forEach((id) => journal[field].delete(id))
        }
        done.folders.forEach((id) => journal.gone.delete(id))
      }
    },
    newDevice: () => device,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (failures.saves > 0) {
          failures.saves -= 1
          throw new Error('quota')
        }
        storage.set(key, value)
      }
    },
    now: () => clock.now,
    report
  })
  return {
    state,
    sync,
    device,
    report,
    journal,
    failures,
    intend: (change: Intended) => {
      for (const field of ['filed', 'archived', 'folders'] as const) {
        change[field]?.forEach((id) => journal[field].add(id))
      }
      for (const [id, folder] of Object.entries(change.gone ?? {})) {
        journal.gone.set(id, folder)
      }
    }
  }
}

const filed = (folders: SessionFolderMetadata['folders'], membership: Record<string, string>) => ({
  version: 1 as const,
  folders,
  membership
})

describe('createSessionAccountSync', () => {
  it('files and archives a session on one computer and the other follows, by its own key', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    bigmac.state.metadata = filed(
      [
        { id: CLIENTS, name: 'Clients' },
        { id: ACME, name: 'Acme', parentId: CLIENTS }
      ],
      { [BIGMAC_KEY]: ACME }
    )
    await bigmac.sync.run()
    await laptop.sync.run()
    expect(laptop.state.metadata.folders.map((folder) => folder.name)).toEqual(['Clients', 'Acme'])
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: ACME })
    clock.now = 2_000
    laptop.state.archived = [LAPTOP_KEY]
    laptop.state.archivedAt = { [LAPTOP_KEY]: 2_000 }
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.archived).toEqual([BIGMAC_KEY])
    clock.now = 3_000
    bigmac.state.metadata = { ...bigmac.state.metadata, membership: { [BIGMAC_KEY]: CLIENTS } }
    bigmac.intend({ filed: [BIGMAC_KEY] })
    await bigmac.sync.run()
    await laptop.sync.run()
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: CLIENTS })
    // Each computer wrote only its own documents.
    const writers = new Set(shared.write.mock.calls.map(([args]) => args.key.split('.')[3]))
    expect(writers.size).toBe(2)
  })

  it('keeps both computers’ edits when they sync at the same time', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const second = sessionKey('local', 'session-2')
    const bigmac = computer(shared, [BIGMAC_KEY, second], clock)
    const laptop = computer(shared, [LAPTOP_KEY, sessionKey('runtime:bigmac', 'session-2')], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], {})
    await bigmac.sync.run()
    await laptop.sync.run()
    clock.now = 2_000
    bigmac.state.metadata = { ...bigmac.state.metadata, membership: { [BIGMAC_KEY]: CLIENTS } }
    laptop.state.archived = [sessionKey('runtime:bigmac', 'session-2')]
    // Both read before either writes: the old last-writer-wins race.
    await Promise.all([bigmac.sync.run(), laptop.sync.run()])
    await Promise.all([bigmac.sync.run(), laptop.sync.run()])
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: CLIENTS })
    expect(bigmac.state.archived).toEqual([second])
  })

  it('never lets a first sighting, a first sync or a provider discovery undo another filing', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed(
      [
        { id: CLIENTS, name: 'Clients' },
        { id: OTHER, name: 'Other' }
      ],
      {
        [BIGMAC_KEY]: CLIENTS
      }
    )
    await bigmac.sync.run()
    clock.now = 5_000
    // The laptop's own old filing (made before it synced) and a later sighting both lose.
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    laptop.state.metadata = filed([{ id: OTHER, name: 'Other' }], { [LAPTOP_KEY]: OTHER })
    await laptop.sync.run()
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: CLIENTS })
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: CLIENTS })
  })

  it('makes one folder of the same folder made on two computers before they synced', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], {})
    await bigmac.sync.run()
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    laptop.state.metadata = filed([{ id: LAPTOP_CLIENTS, name: 'Clients' }], {
      [LAPTOP_KEY]: LAPTOP_CLIENTS
    })
    await laptop.sync.run()
    expect(laptop.state.metadata.folders).toEqual([{ id: CLIENTS, name: 'Clients' }])
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: CLIENTS })
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: CLIENTS })
  })

  it('deletes and unarchives everywhere only when the person did it, and restores lost storage', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], { [BIGMAC_KEY]: CLIENTS })
    bigmac.state.archived = [BIGMAC_KEY]
    await bigmac.sync.run()
    await laptop.sync.run()
    expect(laptop.state.archived).toEqual([LAPTOP_KEY])
    // Lost storage on the laptop: no intent, so nothing is deleted anywhere and it is restored.
    clock.now = 2_000
    laptop.state.metadata = emptySessionFolderMetadata()
    laptop.state.archived = []
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.folders).toHaveLength(1)
    expect(bigmac.state.archived).toEqual([BIGMAC_KEY])
    expect(laptop.state.metadata.folders).toHaveLength(1)
    expect(laptop.state.archived).toEqual([LAPTOP_KEY])
    // The person deletes the folder and unarchives on the laptop: both carry over.
    clock.now = 3_000
    laptop.state.metadata = emptySessionFolderMetadata()
    laptop.state.archived = []
    laptop.intend({ folders: [CLIENTS], archived: [LAPTOP_KEY] })
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.folders).toEqual([])
    expect(bigmac.state.archived).toEqual([])
  })

  it('keeps a session saved when a saved folder it is in is deleted elsewhere', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    const laptop = computer(shared, [], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Kept', section: 'saved' }], {
      [BIGMAC_KEY]: CLIENTS
    })
    await bigmac.sync.run()
    await laptop.sync.run()
    clock.now = 2_000
    laptop.state.metadata = emptySessionFolderMetadata()
    laptop.intend({ folders: [CLIENTS] })
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: SAVED_SESSIONS_FOLDER_ID })
  })

  it('stamps an edit after anything it has seen, whatever its own clock says', async () => {
    const shared = account()
    const ahead = { now: 10_000 }
    const behind = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], ahead)
    const laptop = computer(shared, [LAPTOP_KEY], behind)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], {})
    bigmac.state.archived = [BIGMAC_KEY]
    await bigmac.sync.run()
    await laptop.sync.run()
    laptop.state.archived = []
    laptop.intend({ archived: [LAPTOP_KEY] })
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.archived).toEqual([])
    expect(laptop.state.archived).toEqual([])
  })

  it('drops an answer read for an account or scope that changed while it was in flight', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], {})
    await bigmac.sync.run()
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    shared.read.mockImplementationOnce(async () => {
      laptop.state.scope = 'another-account'
      return { ok: true as const, user: 'user_sal', prefs: { ...shared.prefs } }
    })
    await laptop.sync.run()
    expect(laptop.state.metadata.folders).toEqual([])
  })

  it('saves a session filed in a deleted saved folder on a computer that sees it only later', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Kept', section: 'saved' }], {
      [BIGMAC_KEY]: CLIENTS
    })
    await bigmac.sync.run()
    // The laptop knows the folder but cannot show the session, and deletes the folder.
    const laptop = computer(shared, [], clock)
    await laptop.sync.run()
    clock.now = 2_000
    laptop.state.metadata = emptySessionFolderMetadata()
    laptop.intend({ folders: [CLIENTS] })
    await laptop.sync.run()
    await bigmac.sync.run()
    const later = sessionKey('runtime:bigmac-2')
    const third = computer(shared, [later], clock)
    await third.sync.run()
    expect(third.state.metadata.membership).toEqual({ [later]: SAVED_SESSIONS_FOLDER_ID })
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: SAVED_SESSIONS_FOLDER_ID })
  })

  it('publishes a move the person makes on a session this computer has not synced yet', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed(
      [
        { id: CLIENTS, name: 'Clients' },
        { id: OTHER, name: 'Other' }
      ],
      { [BIGMAC_KEY]: CLIENTS }
    )
    await bigmac.sync.run()
    const laptop = computer(shared, [], clock)
    await laptop.sync.run()
    // The session shows up and the person files it before the next pass.
    clock.now = 2_000
    laptop.state.present = [LAPTOP_KEY]
    laptop.state.metadata = { ...laptop.state.metadata, membership: { [LAPTOP_KEY]: OTHER } }
    laptop.intend({ filed: [LAPTOP_KEY] })
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: OTHER })
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: OTHER })
  })

  it('publishes an unfiling of a session no longer shown, and settles only what it recorded', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], { [BIGMAC_KEY]: CLIENTS })
    await bigmac.sync.run()
    await laptop.sync.run()
    clock.now = 2_000
    laptop.state.metadata = { ...laptop.state.metadata, membership: {} }
    laptop.state.present = []
    laptop.intend({ filed: [LAPTOP_KEY] })
    // A failed read settles nothing; the next pass still carries the person's change.
    shared.read.mockResolvedValueOnce({ ok: false, message: 'offline' })
    await laptop.sync.run()
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({})
  })

  it('splits a computer’s documents when they outgrow omnios, and the other computer gets all', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const ids = Array.from({ length: 8_000 }, (_, index) => `session-${index}`)
    const bigmac = computer(
      shared,
      ids.map((id) => sessionKey('local', id)),
      clock
    )
    const laptop = computer(
      shared,
      ids.map((id) => sessionKey('runtime:bigmac', id)),
      clock
    )
    const folders = Array.from({ length: 150 }, (_, index) => ({
      id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
      name: `${'文'.repeat(75)}${index}`
    }))
    bigmac.state.metadata = filed(
      folders,
      Object.fromEntries(ids.map((id) => [sessionKey('local', id), folders[0]!.id]))
    )
    bigmac.state.archived = ids.map((id) => sessionKey('local', id))
    await bigmac.sync.run()
    const docs = Object.keys(shared.prefs).filter((key) => key.includes(bigmac.device))
    expect(docs.filter((key) => key.includes('.s.')).length).toBeGreaterThan(16)
    expect(docs.filter((key) => key.includes('.f.')).length).toBeGreaterThan(1)
    for (const key of docs) {
      expect(accountSyncValueSize(shared.prefs[key])).toBeLessThanOrEqual(32_000)
    }
    expect(bigmac.report).not.toHaveBeenCalled()
    await laptop.sync.run()
    expect(laptop.state.metadata.folders).toHaveLength(150)
    expect(Object.keys(laptop.state.metadata.membership)).toHaveLength(8_000)
    expect(laptop.state.archived).toHaveLength(8_000)
  })

  it('tells the person once when omnios keeps refusing a document', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], { [BIGMAC_KEY]: CLIENTS })
    shared.write.mockResolvedValue({ ok: false, message: 'refused' })
    for (let pass = 0; pass < 5; pass++) {
      await bigmac.sync.run()
    }
    expect(bigmac.report).toHaveBeenCalledTimes(1)
    expect(bigmac.report).toHaveBeenCalledWith({ kind: 'refused', message: 'refused' })
  })

  it('never loses published entries while its documents double, even if a write fails', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const folder = (index: number) => ({
      id: `${String(index).padStart(8, '0')}-2222-4222-8222-222222222222`,
      name: `${'文'.repeat(75)}${index}`
    })
    const bigmac = computer(shared, [], clock)
    bigmac.state.metadata = filed(
      Array.from({ length: 50 }, (_, index) => folder(index)),
      {}
    )
    await bigmac.sync.run()
    expect(Object.keys(shared.prefs).filter((key) => key.includes('.f.'))).toHaveLength(1)
    bigmac.state.metadata = filed(
      Array.from({ length: 65 }, (_, index) => folder(index)),
      {}
    )
    // The first new document fails to land: the old one must keep every folder it held.
    let refused = false
    shared.write.mockImplementationOnce(async () => {
      refused = true
      return { ok: false, message: 'offline' }
    })
    await bigmac.sync.run()
    expect(refused).toBe(true)
    const early = computer(shared, [], clock)
    await early.sync.run()
    expect(early.state.metadata.folders.length).toBeGreaterThanOrEqual(50)
    await bigmac.sync.run()
    const fresh = computer(shared, [], clock)
    await fresh.sync.run()
    expect(fresh.state.metadata.folders).toHaveLength(65)
  })

  it('never republishes a change it applied when saving its own state failed', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const G = '55555555-5555-4555-8555-555555555555'
    const H = '66666666-6666-4666-8666-666666666666'
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    bigmac.state.metadata = filed(
      [
        { id: CLIENTS, name: 'F' },
        { id: G, name: 'G' },
        { id: H, name: 'H' }
      ],
      { [BIGMAC_KEY]: CLIENTS }
    )
    await bigmac.sync.run()
    await laptop.sync.run()
    clock.now = 2_000
    bigmac.state.metadata = { ...bigmac.state.metadata, membership: { [BIGMAC_KEY]: G } }
    bigmac.intend({ filed: [BIGMAC_KEY] })
    await bigmac.sync.run()
    laptop.failures.saves = 1
    await laptop.sync.run()
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: G })
    clock.now = 3_000
    bigmac.state.metadata = { ...bigmac.state.metadata, membership: { [BIGMAC_KEY]: H } }
    bigmac.intend({ filed: [BIGMAC_KEY] })
    await bigmac.sync.run()
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: H })
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: H })
  })

  it('deletes a folder as it was when deleted, not as it was last synced', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Kept', section: 'saved' }], {
      [BIGMAC_KEY]: CLIENTS
    })
    await bigmac.sync.run()
    const laptop = computer(shared, [], clock)
    await laptop.sync.run()
    // Moved out of Saved and deleted on the laptop before it synced the move.
    clock.now = 2_000
    laptop.state.metadata = emptySessionFolderMetadata()
    laptop.intend({ folders: [CLIENTS], gone: { [CLIENTS]: { n: 'Kept' } } })
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.folders).toEqual([])
    expect(bigmac.state.metadata.membership).toEqual({})
  })

  it('keeps a change to a pane until the pane is named by its provider session', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const pane = JSON.stringify(['local', 'pane', 'wt', 'tab:1'])
    const routine = JSON.stringify(['local', 'routine', 'r1'])
    const laptop = computer(shared, [pane], clock)
    laptop.intend({ filed: [pane, LAPTOP_KEY, routine] })
    await laptop.sync.run()
    // The named session is recorded and the routine can never sync; only the pane waits.
    expect([...laptop.journal.filed]).toEqual([pane])
  })

  it('publishes an unfiling and unarchiving made under one of two keys for the same session', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, [BIGMAC_KEY], clock)
    // The laptop re-registered the repository: an old key and the current one name one session.
    const old = JSON.stringify([
      'runtime:bigmac',
      'provider',
      'repo-old::/work/app\0claude\0claude\0session-1'
    ])
    const laptop = computer(shared, [LAPTOP_KEY], clock)
    bigmac.state.metadata = filed([{ id: CLIENTS, name: 'Clients' }], { [BIGMAC_KEY]: CLIENTS })
    bigmac.state.archived = [BIGMAC_KEY]
    await bigmac.sync.run()
    await laptop.sync.run()
    laptop.state.metadata = {
      ...laptop.state.metadata,
      membership: { [old]: CLIENTS, [LAPTOP_KEY]: CLIENTS }
    }
    laptop.state.archived = [old, LAPTOP_KEY]
    clock.now = 2_000
    laptop.state.metadata = { ...laptop.state.metadata, membership: { [old]: CLIENTS } }
    laptop.state.archived = [old]
    laptop.intend({ filed: [LAPTOP_KEY], archived: [LAPTOP_KEY] })
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({})
    expect(bigmac.state.archived).toEqual([])
    // Every key the laptop holds the session under follows, the old one too.
    expect(laptop.state.metadata.membership).toEqual({})
    expect(laptop.state.archived).toEqual([])
  })
})
