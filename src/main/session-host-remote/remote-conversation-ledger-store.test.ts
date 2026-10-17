import { mkdtemp, readFile, readdir, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeSessionConversationLedger } from '../../shared/session-conversation-ledger'
import { readRememberConversationLedgerRequest } from '../../shared/remote-conversation-ledger-snapshot'
import type { RuntimeSessionWorkflowRecordSet } from '../../shared/session-workflow-records'
import { RemoteConversationLedgerStore } from './remote-conversation-ledger-store'

const ENV = '6f8f2a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const WT = 'repo::/work'
const HOST = `host_${'a'.repeat(32)}`
const OTHER_HOST = `host_${'b'.repeat(32)}`

function ledger(
  revision: number,
  overrides: Partial<RuntimeSessionConversationLedger> = {}
): RuntimeSessionConversationLedger {
  return {
    generation: 'gen-1',
    revision,
    source: 'window',
    listedAt: 1_000,
    coverage: [{ worktreeId: WT, complete: true }],
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [{ id: 'folder-1', name: 'Clients' }],
    projects: [{ folderId: 'folder-1' }],
    recordsByWorktree: {
      [WT]: [
        {
          conversation: 'a'.repeat(24),
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-1' },
          title: 'Release notes',
          titleSource: 'custom',
          surface: 'record',
          rest: 'asleep',
          archived: { archived: true, byHand: true },
          folderId: 'folder-1',
          listed: true,
          updatedAt: 5
        }
      ]
    },
    removals: [{ conversation: 'b'.repeat(24), worktreeId: WT, at: 7 }],
    ...overrides
  }
}

const workflows: RuntimeSessionWorkflowRecordSet = {
  generation: 'wf-1',
  revision: 3,
  complete: false,
  recordsByWorktree: {
    [WT]: [{ tabId: 'flow', preset: 'council', title: 'Plan', status: 'done', runId: 'run-1' }]
  }
}

let directory: string

function store(
  options: Partial<ConstructorParameters<typeof RemoteConversationLedgerStore>[0]> = {}
): RemoteConversationLedgerStore {
  return new RemoteConversationLedgerStore({
    directory,
    now: () => 2_000,
    ...options
  })
}

describe('the durable receiver snapshots of paired owners’ ledgers (session parity, step 5)', () => {
  beforeEach(async () => {
    directory = join(await mkdtemp(join(tmpdir(), 'remote-ledgers-')), 'session-host', 'ledgers')
  })

  afterEach(async () => {
    await rm(join(directory, '..', '..'), { recursive: true, force: true })
  })

  it('round-trips a remembered ledger and its workflows through <environmentId>.json', async () => {
    const first = store()
    await first.remember({
      environmentId: ENV,
      set: ledger(4),
      asOf: 1_500,
      workflowRecords: workflows,
      workflowsAsOf: 1_400
    })
    await first.flush()
    expect(await readdir(directory)).toEqual([`${ENV}.json`])

    const [snapshot] = await store().snapshots()
    expect(snapshot).toMatchObject({
      environmentId: ENV,
      asOf: 1_500,
      workflowsAsOf: 1_400,
      savedAt: 2_000,
      set: { generation: 'gen-1', revision: 4, folders: [{ id: 'folder-1', name: 'Clients' }] },
      workflowRecords: { generation: 'wf-1', revision: 3 }
    })
    expect(snapshot?.set?.recordsByWorktree[WT]?.[0]).toMatchObject({
      archived: { archived: true, byHand: true },
      folderId: 'folder-1'
    })
    expect(snapshot?.set?.removals).toEqual([
      { conversation: 'b'.repeat(24), worktreeId: WT, at: 7 }
    ])
  })

  it('keeps each workspace’s own workflow "as of" beside the newest (review B3)', async () => {
    const kept = store()
    await kept.remember(
      readRememberConversationLedgerRequest({
        environmentId: ENV,
        workflowRecords: workflows,
        workflowsAsOf: 1_400,
        workflowsAsOfByWorktree: { [WT]: 900 },
        urgent: true
      })!
    )
    await kept.flush()
    const [snapshot] = await store().snapshots()
    expect(snapshot).toMatchObject({
      workflowsAsOf: 1_400,
      workflowsAsOfByWorktree: { [WT]: 900 }
    })
    expect(snapshot).not.toHaveProperty('urgent')
  })

  it('never reads a kept snapshot as proof of an absence', async () => {
    const first = store()
    await first.remember({
      environmentId: ENV,
      set: ledger(4),
      asOf: 1_500,
      workflowRecords: { ...workflows, complete: true }
    })
    await first.flush()
    const [snapshot] = await store().snapshots()
    expect(snapshot?.set?.coverage).toEqual([{ worktreeId: WT, complete: false }])
    expect(snapshot?.workflowRecords?.complete).toBe(false)
  })

  it('ignores a corrupt, foreign or misnamed file', async () => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${ENV}.json`), '{ not json')
    await writeFile(
      join(directory, 'other-env.json'),
      JSON.stringify({ v: 1, environmentId: ENV, savedAt: 1, set: ledger(1) })
    )
    await writeFile(join(directory, 'notes.txt'), 'hello')
    await writeFile(
      join(directory, 'future-env.json'),
      JSON.stringify({ v: 2, environmentId: 'future-env', savedAt: 1 })
    )
    expect(await store().snapshots()).toEqual([])
  })

  it('records the owner’s journal hostId: its own reading first, then the window’s, then the kept one', async () => {
    const resolved: { hostId: string | null } = { hostId: HOST }
    const kept = store({ resolveOwnerHostId: () => resolved.hostId })
    await kept.remember({ environmentId: ENV, ownerHostId: OTHER_HOST, set: ledger(1), asOf: 1 })
    expect((await kept.snapshots())[0]?.ownerHostId).toBe(HOST)

    resolved.hostId = null
    await kept.remember({ environmentId: ENV, ownerHostId: OTHER_HOST, set: ledger(2), asOf: 2 })
    expect((await kept.snapshots())[0]?.ownerHostId).toBe(OTHER_HOST)

    // Unknown everywhere now: the hostId kept so far stays, on disk too.
    await kept.remember({ environmentId: ENV, set: ledger(3), asOf: 3 })
    await kept.flush()
    const file = JSON.parse(await readFile(join(directory, `${ENV}.json`), 'utf8'))
    expect(file).toMatchObject({ v: 1, environmentId: ENV, ownerHostId: OTHER_HOST })
    expect((await store().snapshots())[0]?.ownerHostId).toBe(OTHER_HOST)
  })

  it('replaces only the parts a request carries', async () => {
    const kept = store()
    await kept.remember({
      environmentId: ENV,
      set: ledger(1),
      asOf: 1,
      workflowRecords: workflows,
      workflowsAsOf: 1
    })
    await kept.remember({ environmentId: ENV, set: ledger(2), asOf: 2 })
    await kept.flush()
    const [snapshot] = await store().snapshots()
    expect(snapshot).toMatchObject({
      asOf: 2,
      set: { revision: 2 },
      workflowRecords: { revision: 3 }
    })
  })

  // Review B2: a busy owner republishes on every agent turn; the receiver must not fsync per delta.
  it('writes an urgent change at once and a plain one only after its burst settles, then on flush', async () => {
    const kept = store({ debounceMs: 60 })
    await kept.remember({ environmentId: ENV, set: ledger(1), asOf: 1 })
    await kept.remember({ environmentId: ENV, set: ledger(2), asOf: 2 })
    expect(await readdir(directory).catch(() => [])).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await store().snapshots())[0]?.set?.revision).toBe(2)

    await kept.remember({ environmentId: ENV, set: ledger(3), asOf: 3 })
    expect((await store().snapshots())[0]?.set?.revision).toBe(2)
    await kept.flush()
    expect((await store().snapshots())[0]?.set?.revision).toBe(3)

    await kept.remember({ environmentId: ENV, set: ledger(4), asOf: 4, urgent: true })
    // Why flush here: it only awaits the write the urgent change already started.
    await kept.flush()
    expect((await store().snapshots())[0]?.set?.revision).toBe(4)
  })

  it('does not rewrite a snapshot whose content the file already holds', async () => {
    // Why through the reader: the IPC handler hands the store requests the reader normalised.
    const request = readRememberConversationLedgerRequest({
      environmentId: ENV,
      set: ledger(1),
      asOf: 1,
      urgent: true
    })!
    let now = 2_000
    const kept = store({ now: () => now, debounceMs: 0 })
    await kept.remember(request)
    await kept.flush()
    const written = await readFile(join(directory, `${ENV}.json`), 'utf8')
    now = 3_000
    await kept.remember(request)
    await kept.flush()
    expect(await readFile(join(directory, `${ENV}.json`), 'utf8')).toBe(written)
    // A fresh store reads the file as what it last wrote, so the same content is still skipped.
    const again = store({ now: () => 4_000 })
    await again.remember(request)
    await again.flush()
    expect(await readFile(join(directory, `${ENV}.json`), 'utf8')).toBe(written)
  })

  it('sweeps stale durable-write temps at construction and leaves fresh ones', async () => {
    await mkdir(directory, { recursive: true })
    const stale = join(directory, `${ENV}.json.1.1.deadbeef.tmp`)
    const fresh = join(directory, `${ENV}.json.1.2.cafebabe.tmp`)
    await writeFile(stale, '{}')
    await writeFile(fresh, '{}')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(stale, old, old)
    store()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await readdir(directory)).sort()).toEqual([`${ENV}.json.1.2.cafebabe.tmp`])
  })

  it('reads only owners still kept, and removes a snapshot older than the deletion history', async () => {
    const other = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'
    const seed = store({ now: () => 1_000 })
    await seed.remember({ environmentId: ENV, set: ledger(1), asOf: 1, urgent: true })
    await seed.remember({ environmentId: other, set: ledger(1), asOf: 1, urgent: true })
    await seed.flush()
    expect((await readdir(directory)).sort()).toEqual([`${other}.json`, `${ENV}.json`].sort())

    const kept = store({ now: () => 2_000, isKept: (environmentId) => environmentId === ENV })
    expect((await kept.snapshots()).map((snapshot) => snapshot.environmentId)).toEqual([ENV])
    // The unpaired owner's file stays for a re-pair (G4) — unread, never shipped.
    expect((await readdir(directory)).sort()).toEqual([`${other}.json`, `${ENV}.json`].sort())

    const later = store({ now: () => 1_000 + 91 * 24 * 60 * 60 * 1000 })
    expect(await later.snapshots()).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })

  it('files nothing under a name that is not a plain environment id', () => {
    expect(
      readRememberConversationLedgerRequest({ environmentId: '../escape', set: ledger(1) })
    ).toBeNull()
    expect(
      readRememberConversationLedgerRequest({ environmentId: 'a/b', set: ledger(1) })
    ).toBeNull()
    expect(
      readRememberConversationLedgerRequest({ environmentId: ENV, ownerHostId: 'nope' })
    ).toEqual({
      environmentId: ENV
    })
  })

  it('keeps no prompt or path a request smuggles in', async () => {
    const smuggled = JSON.parse(JSON.stringify(ledger(1))) as Record<string, unknown>
    const records = (smuggled.recordsByWorktree as Record<string, Record<string, unknown>[]>)[WT]!
    records[0]!.prompt = 'SENTINEL-PROMPT'
    records[0]!.transcriptPath = '/Users/someone/SENTINEL-PATH.jsonl'
    const kept = store()
    await kept.remember(
      readRememberConversationLedgerRequest({ environmentId: ENV, set: smuggled, asOf: 1 })!
    )
    await kept.flush()
    const raw = await readFile(join(directory, `${ENV}.json`), 'utf8')
    expect(raw).not.toContain('SENTINEL')
  })
})
