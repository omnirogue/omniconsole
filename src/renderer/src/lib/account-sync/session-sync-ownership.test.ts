import { describe, expect, it, vi } from 'vitest'
import type {
  AccountSyncReadResult,
  AccountSyncWriteArgs,
  AccountSyncWriteResult
} from '../../../../shared/account-sync-types'
import type {
  OrganizationExecutorKind,
  OrganizationKeyState,
  OrganizationRecord
} from '../../../../shared/session-organization-change'
import type { OwnershipSyncStamp } from '../../../../shared/session-organization-ownership'
import { emptySessionFolderMetadata, type SessionFolderMetadata } from '@/lib/session-folders'
import { createSessionOrganizationOwnershipStore } from '@/store/session-organization-ownership'
import type { SessionOrganizationIntent } from './session-organization-intent'
import { createSessionAccountSync } from './session-sync-engine'
import { createSessionSyncOwnership } from './session-sync-ownership'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key
}))

const CLIENTS = '11111111-1111-4111-8111-111111111111'
const ACME = '22222222-2222-4222-8222-222222222222'

/** The same Claude session, named from its own computer and from one paired with it. */
const sessionKey = (host: string) =>
  JSON.stringify([host, 'provider', 'repo::/work/app\0claude\0claude\0session-1'])
const BIGMAC_KEY = sessionKey('local')
const LAPTOP_KEY = sessionKey('runtime:bigmac')
const FOLDERS = [
  { id: CLIENTS, name: 'Clients' },
  { id: ACME, name: 'Acme', parentId: CLIENTS }
]

function account() {
  const prefs: Record<string, unknown> = {}
  return {
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

/** A computer; with `ownership` it runs this build, without it an older app that knows none. */
function computer(
  shared: ReturnType<typeof account>,
  key: string,
  clock: { now: number },
  ownership: boolean
) {
  const device = (++devices).toString(16).padStart(8, '0')
  const storage = new Map<string, string>()
  const state = {
    metadata: { ...emptySessionFolderMetadata(), folders: FOLDERS } as SessionFolderMetadata,
    archived: [] as string[],
    archivedAt: {} as Record<string, number>,
    present: [key],
    folderPaths: {}
  }
  const journal: SessionOrganizationIntent = {
    filed: new Set(),
    archived: new Set(),
    folders: new Set(),
    gone: new Map()
  }
  const mirror = createSessionOrganizationOwnershipStore(() => ({
    getItem: () => null,
    setItem: () => {}
  }))
  const sent = { stamps: [] as OwnershipSyncStamp[], records: [] as OrganizationRecord[] }
  let opIds = 0
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
        filed: new Set(journal.filed),
        archived: new Set(journal.archived),
        folders: new Set(journal.folders),
        gone: new Map(journal.gone)
      }),
      settle: (_scope, done) => done.filed.forEach((id) => journal.filed.delete(id))
    },
    newDevice: () => device,
    storage: {
      getItem: (name) => storage.get(name) ?? null,
      setItem: (name, value) => {
        storage.set(name, value)
      }
    },
    now: () => clock.now,
    report: vi.fn(),
    ...(ownership
      ? {
          organization: createSessionSyncOwnership({
            mirror: mirror.getState(),
            outbox: {
              stamps: (stamps) => sent.stamps.push(...stamps),
              records: (records) => sent.records.push(...records)
            },
            mintOpId: () => `sync-${device}-${++opIds}`,
            now: () => new Date(clock.now)
          })
        }
      : {})
  })
  return {
    state,
    sync,
    mirror,
    sent,
    /** Files the session here as a local edit (the person's or an agent's, the store notes both). */
    file: (folder: string) => {
      state.metadata = { ...state.metadata, membership: { [key]: folder } }
      journal.filed.add(key)
    },
    /** What main recorded for the window's own agent change (or a 1a seed). */
    own: (placement: NonNullable<OrganizationKeyState['ownership']['placement']>) =>
      mirror.getState().adopt({ [key]: { ownership: { placement }, revocations: {} } }, false),
    placement: () => mirror.getState().ownedField(key, 'placement')
  }
}

const agentFiling = (opId: string, value: string, by: OrganizationExecutorKind = 'pane') => ({
  value,
  revision: opId,
  by,
  opId,
  at: '2026-09-25T10:00:00.000Z'
})

async function stewardFiledOnBigmac() {
  const shared = account()
  const clock = { now: 1_000 }
  const bigmac = computer(shared, BIGMAC_KEY, clock, true)
  const laptop = computer(shared, LAPTOP_KEY, clock, false)
  bigmac.file(ACME)
  bigmac.own(agentFiling('agent-1', ACME))
  await bigmac.sync.run()
  clock.now = 2_000
  await laptop.sync.run()
  return { shared, clock, bigmac, laptop }
}

describe('account sync and steward ownership', () => {
  it('notes the stamp it authors on the owned filing, and its echo never takes ownership back', async () => {
    const { clock, bigmac, laptop } = await stewardFiledOnBigmac()
    expect(laptop.state.metadata.membership).toEqual({ [LAPTOP_KEY]: ACME })
    const stamp = bigmac.placement()?.syncStamp
    expect(stamp).toBe(1_000)
    expect(bigmac.sent.stamps).toEqual([
      { key: BIGMAC_KEY, field: 'placement', opId: 'agent-1', stamp: 1_000 }
    ])
    clock.now = 3_000
    await bigmac.sync.run()
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.placement()).toMatchObject({ opId: 'agent-1', syncStamp: 1_000 })
    expect(bigmac.sent.records).toEqual([])
  })

  it('takes ownership back when an older app moves it X → Y → X, though the folder is the same', async () => {
    const { clock, bigmac, laptop } = await stewardFiledOnBigmac()
    clock.now = 4_000
    laptop.file(CLIENTS)
    await laptop.sync.run()
    clock.now = 5_000
    laptop.file(ACME)
    await laptop.sync.run()
    // Only the stamp changed in the account: the older app's document holds [ACME, 5000].
    clock.now = 6_000
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: ACME })
    expect(bigmac.placement()).toBeNull()
    expect(bigmac.mirror.getState().stateFor(BIGMAC_KEY).revocations.placement).toMatchObject({
      why: 'sync/5000'
    })
    expect(bigmac.sent.records).toEqual([
      expect.objectContaining({
        kind: 'move',
        targets: [{ sessionKey: BIGMAC_KEY }],
        executor: { kind: 'sync', stamp: 5_000 },
        revision: 'sync:5000',
        before: [ACME],
        after: [ACME]
      })
    ])
  })

  it('records a move another computer made and takes ownership back', async () => {
    const { clock, bigmac, laptop } = await stewardFiledOnBigmac()
    clock.now = 4_000
    laptop.file(CLIENTS)
    await laptop.sync.run()
    await bigmac.sync.run()
    expect(bigmac.state.metadata.membership).toEqual({ [BIGMAC_KEY]: CLIENTS })
    expect(bigmac.placement()).toBeNull()
    expect(bigmac.sent.records).toEqual([
      expect.objectContaining({
        executor: { kind: 'sync', stamp: 4_000 },
        before: [ACME],
        after: [CLIENTS],
        value: CLIENTS
      })
    ])
  })

  it('keeps a filing recorded after its sync (or seeded from 1a) when the stamp is its own', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, BIGMAC_KEY, clock, true)
    bigmac.file(ACME)
    await bigmac.sync.run()
    // Main confirms the agent's filing only now: it has no stamp yet.
    bigmac.own(agentFiling('late', ACME))
    clock.now = 2_000
    await bigmac.sync.run()
    expect(bigmac.placement()).toMatchObject({ opId: 'late', syncStamp: 1_000 })
    expect(bigmac.sent.stamps).toEqual([
      { key: BIGMAC_KEY, field: 'placement', opId: 'late', stamp: 1_000 }
    ])
  })

  it('takes a seeded filing back when another computer re-stamped it before this one noted a stamp', async () => {
    const shared = account()
    const clock = { now: 1_000 }
    const bigmac = computer(shared, BIGMAC_KEY, clock, true)
    const laptop = computer(shared, LAPTOP_KEY, clock, false)
    bigmac.file(ACME)
    await bigmac.sync.run()
    await laptop.sync.run()
    clock.now = 2_000
    laptop.file(CLIENTS)
    await laptop.sync.run()
    clock.now = 3_000
    laptop.file(ACME)
    await laptop.sync.run()
    bigmac.own(agentFiling('seed:b1', ACME, 'launch'))
    await bigmac.sync.run()
    expect(bigmac.placement()).toBeNull()
  })
})
