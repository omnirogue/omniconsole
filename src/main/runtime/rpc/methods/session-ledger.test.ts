import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeSessionConversationLedger,
  RuntimeSessionConversationRecord
} from '../../../../shared/session-conversation-ledger'
import type { SessionLedgerReadResult } from '../../../../shared/session-ledger-read'
import { SessionConversationLedgerStore } from '../../session-conversation-ledger-store'
import type { RpcContext } from '../core'
import { SESSION_LEDGER_METHODS } from './session-ledger'

const mocks = vi.hoisted(() => ({ snapshots: vi.fn() }))
vi.mock('../../../session-host-remote/remote-conversation-ledger-runtime', () => ({
  getRemoteConversationLedgerStore: () => ({ snapshots: mocks.snapshots })
}))

const WT = 'repo::/project-a'
const LISTED = 'a1b2c3d4e5f60718293a4b5c'
const HELD = 'ffeeddccbbaa998877665544'
const PANE = '9a3f0c11-5b7e-4c55-9d0e-1f2a3b4c5d6e:00000000-0000-4000-8000-000000000001'

function record(
  overrides: Partial<RuntimeSessionConversationRecord>
): RuntimeSessionConversationRecord {
  return {
    conversation: LISTED,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 's1' },
    title: 'Ads check',
    titleSource: 'custom',
    surface: 'record',
    rest: 'asleep',
    listed: true,
    updatedAt: 1,
    ...overrides
  }
}

const RECORDS = [
  record({ archived: { archived: true, byHand: true } }),
  record({ conversation: HELD, listed: false, providerSession: { key: 'session_id', id: 's2' } }),
  record({
    conversation: null,
    paneIdentity: `pane:${PANE}`,
    providerSession: null,
    surface: 'tab',
    paneKey: PANE,
    rest: 'dormant',
    archived: { archived: false }
  })
]

function ownStore(): SessionConversationLedgerStore {
  return new SessionConversationLedgerStore({ ownerLedgerPath: null })
}

async function call(
  params: { host?: string } | undefined,
  store: SessionConversationLedgerStore = ownStore(),
  extra: Record<string, unknown> = {}
): Promise<SessionLedgerReadResult> {
  const method = SESSION_LEDGER_METHODS[0]!
  return (await method.handler(params, {
    ...extra,
    runtime: { getSessionConversationLedgerStore: () => store }
  } as unknown as RpcContext)) as SessionLedgerReadResult
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.snapshots.mockResolvedValue([])
})

describe('session.ledger (session parity, F19)', () => {
  it("reads this computer's own ledger as paired computers receive it, rows in parity terms", async () => {
    const store = ownStore()
    store.publishWindow({
      rendererGeneration: 'renderer-1',
      listedAt: 1_000,
      coverage: [{ worktreeId: WT, complete: true }],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [],
      projects: [],
      recordsByWorktree: { [WT]: RECORDS }
    })
    mocks.snapshots.mockResolvedValue([
      { environmentId: 'env-studio', set: snapshotSet(), savedAt: 70 },
      { environmentId: 'env-workflows-only', savedAt: 80 }
    ])

    const read = await call(undefined, store)

    expect(read).toMatchObject({
      hostId: 'local',
      source: 'owner',
      generation: store.generation,
      revision: 1,
      ledgerSource: 'window',
      windowCurrent: true,
      listedAt: 1_000,
      coverage: [{ worktreeId: WT, complete: true }],
      removals: 0,
      counts: { ownerListed: 2, heldByOwner: 1, archived: 1 },
      receivers: [{ hostId: 'runtime:env-studio', savedAt: 70 }]
    })
    expect(read.rows).toEqual([
      {
        hostId: 'local',
        worktreeId: WT,
        kind: 'terminal',
        agent: 'claude',
        archived: true,
        label: 'Ads check',
        bucket: 'ownerListed',
        verification: 'verified',
        identity: `c:${LISTED}`,
        conversation: LISTED,
        rest: 'asleep'
      },
      expect.objectContaining({ bucket: 'heldByOwner', identity: `c:${HELD}`, archived: null }),
      expect.objectContaining({
        bucket: 'ownerListed',
        identity: `p:pane:${PANE}`,
        conversation: null,
        paneIdentity: `pane:${PANE}`,
        rest: 'dormant',
        archived: false
      })
    ])
  })

  it('says none before this runtime has listed anything, and main-authored once its window is gone', async () => {
    const store = ownStore()
    await expect(call(undefined, store)).resolves.toMatchObject({ source: 'none', revision: 0 })
    store.publishWindow({
      rendererGeneration: 'renderer-1',
      listedAt: 1_000,
      coverage: [{ worktreeId: WT, complete: true }],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [],
      projects: [],
      recordsByWorktree: { [WT]: RECORDS }
    })
    store.markPublisherGone()
    await expect(call({ host: 'local' }, store)).resolves.toMatchObject({
      source: 'owner',
      ledgerSource: 'main',
      windowCurrent: false,
      // Why: with no window vouching, the last listing proves no absence.
      coverage: [{ worktreeId: WT, complete: false }]
    })
  })

  it("reads a paired owner's kept copy as stale, and none for an owner never heard or an SSH host", async () => {
    mocks.snapshots.mockResolvedValue([
      { environmentId: 'env-studio', set: snapshotSet(), asOf: 60, savedAt: 70 }
    ])

    const read = await call({ host: 'runtime:env-studio' })
    expect(read).toMatchObject({
      hostId: 'runtime:env-studio',
      source: 'receiver-snapshot',
      generation: 'owner-gen',
      revision: 9,
      ledgerSource: 'window',
      asOf: 60,
      savedAt: 70,
      removals: 1,
      removalsTruncated: true,
      counts: { ownerListed: 2, heldByOwner: 1, archived: 1 }
    })
    expect(read.rows.every((row) => row.verification === 'stale' && row.stale === true)).toBe(true)
    expect(read.rows[0]).toMatchObject({ hostId: 'runtime:env-studio', identity: `c:${LISTED}` })
    expect(read.receivers).toBeUndefined()

    await expect(call({ host: 'runtime:env-never' })).resolves.toMatchObject({
      hostId: 'runtime:env-never',
      source: 'none',
      rows: []
    })
    await expect(call({ host: 'ssh:box' })).resolves.toMatchObject({ source: 'none', rows: [] })
  })

  it('refuses another computer or a paired device', async () => {
    await expect(call(undefined, ownStore(), { pairedDeviceId: 'phone' })).rejects.toThrow()
    await expect(
      call(undefined, ownStore(), { clientId: 'peer', clientKind: 'runtime' })
    ).rejects.toThrow()
  })
})

function snapshotSet(): RuntimeSessionConversationLedger {
  return {
    generation: 'owner-gen',
    revision: 9,
    source: 'window',
    listedAt: 50,
    coverage: [{ worktreeId: WT, complete: false }],
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [],
    projects: [],
    recordsByWorktree: { [WT]: RECORDS },
    removals: [{ conversation: 'abcdefabcdefabcdefabcdef', worktreeId: WT, at: 40 }],
    removalsTruncated: true
  }
}
