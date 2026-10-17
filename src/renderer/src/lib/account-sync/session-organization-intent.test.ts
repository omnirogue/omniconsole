import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptySessionFolderMetadata, type SessionFolderMetadata } from '@/lib/session-folders'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `${key}:account-a`
}))

const FOLDER = '11111111-1111-4111-8111-111111111111'
const KID = '22222222-2222-4222-8222-222222222222'

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  }
}

const metadata = (change: Partial<SessionFolderMetadata>): SessionFolderMetadata => ({
  ...emptySessionFolderMetadata(),
  ...change
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('session organization intent', () => {
  it('notes what an edit changed, survives a restart, and settles only what was recorded', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const before = await import('./session-organization-intent')
    const saved = { id: FOLDER, name: 'Kept', section: 'saved' as const }
    before.noteSessionFolderEdit(
      metadata({ folders: [saved, { id: KID, name: 'Kid', section: 'saved', parentId: FOLDER }] }),
      metadata({
        folders: [{ id: KID, name: 'Kid', section: 'saved' }],
        membership: { s1: KID }
      })
    )
    before.noteSessionsArchived(['s2'])
    before.noteSessionFolderEdit(metadata({}), metadata({}))
    // A restart: a fresh module reads the journal back from storage.
    vi.resetModules()
    const after = await import('./session-organization-intent')
    const scope = after.sessionOrganizationScope()
    const pending = after.pendingSessionOrganizationIntent(scope)
    expect(pending).toEqual({
      filed: new Set(['s1']),
      archived: new Set(['s2']),
      folders: new Set([FOLDER, KID]),
      gone: new Map([[FOLDER, { n: 'Kept', s: 'saved' }]])
    })
    after.noteSessionsArchived(['s3'])
    after.settleSessionOrganizationIntent(scope, pending)
    expect(after.pendingSessionOrganizationIntent(scope).archived).toEqual(new Set(['s3']))
    after.settleSessionOrganizationIntent(scope, after.pendingSessionOrganizationIntent(scope))
    expect(storage.items.size).toBe(0)
    // Another account's journal is its own.
    expect(after.pendingSessionOrganizationIntent('sessions:account-b').filed.size).toBe(0)
  })

  it('moves a pending change to the key a pane learns, and forgets a folder put back', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const intent = await import('./session-organization-intent')
    const scope = intent.sessionOrganizationScope()
    const folder = { id: FOLDER, name: 'Kept' }
    intent.noteSessionFolderEdit(
      metadata({ folders: [folder] }),
      metadata({ membership: { pane: FOLDER } })
    )
    intent.renameNotedSessionKey('filed', 'pane', 'provider')
    intent.noteSessionFolderEdit(metadata({}), metadata({ folders: [folder] }))
    const pending = intent.pendingSessionOrganizationIntent(scope)
    expect(pending.filed).toEqual(new Set(['provider']))
    expect(pending.gone.size).toBe(0)
  })

  it('never drops a pending change to a named session; only old waiting panes go', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const intent = await import('./session-organization-intent')
    const pane = (index: number) => JSON.stringify(['local', 'pane', 'wt', `tab:${index}`])
    const named = (index: number) =>
      JSON.stringify(['local', 'provider', `repo::/app\0claude\0claude\0s${index}`])
    intent.noteSessionsArchived(Array.from({ length: 1_001 }, (_, index) => pane(index)))
    intent.noteSessionsArchived(Array.from({ length: 6_000 }, (_, index) => named(index)))
    const archived = intent.pendingSessionOrganizationIntent(
      intent.sessionOrganizationScope()
    ).archived
    expect(archived.size).toBe(7_000)
    expect(archived.has(pane(0))).toBe(false)
    expect(archived.has(named(0))).toBe(true)
  })

  it('keeps working in memory when storage is unavailable or damaged', async () => {
    const storage = memoryStorage()
    storage.items.set('omni.account-sync.intent:sessions:account-a', '{not json')
    vi.stubGlobal('localStorage', storage)
    const intent = await import('./session-organization-intent')
    const scope = intent.sessionOrganizationScope()
    expect(intent.pendingSessionOrganizationIntent(scope).filed.size).toBe(0)
    storage.setItem = () => {
      throw new Error('quota')
    }
    intent.noteSessionsArchived(['s1'])
    expect(intent.pendingSessionOrganizationIntent(scope).archived).toEqual(new Set(['s1']))
  })
})
