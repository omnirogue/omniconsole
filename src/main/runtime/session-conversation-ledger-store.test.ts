import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  sessionConversationIdentity,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval,
  type SessionConversationLedgerWindowPublication
} from '../../shared/session-conversation-ledger'
import {
  SessionConversationLedgerStore,
  type SessionConversationLedgerMainSet
} from './session-conversation-ledger-store'

const W = 'repo::/work'
const W2 = 'repo::/other'
const SENTINEL = 'SENTINEL-never-kept-on-disk-41c2'

function record(
  id: string,
  overrides: Partial<RuntimeSessionConversationRecord> = {}
): RuntimeSessionConversationRecord {
  const providerSession = { key: 'session_id' as const, id }
  return {
    conversation: sessionConversationIdentity({ worktreeId: W, agent: 'claude', providerSession }),
    agent: 'claude',
    providerSession,
    title: `Claude ${id}`,
    titleSource: 'terminal',
    surface: 'record',
    rest: 'asleep',
    listed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function mainSet(
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>,
  overrides: Partial<SessionConversationLedgerMainSet> = {}
): SessionConversationLedgerMainSet {
  return {
    listedAt: 1_700_000_000_500,
    coverage: Object.keys(recordsByWorktree).map((worktreeId) => ({ worktreeId, complete: true })),
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [{ id: 'f1', name: 'Church' }],
    projects: [{ folderId: 'f1' }],
    recordsByWorktree,
    ...overrides
  }
}

function publication(
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>,
  overrides: Partial<SessionConversationLedgerWindowPublication> = {}
): SessionConversationLedgerWindowPublication {
  return { ...mainSet(recordsByWorktree), rendererGeneration: 'r1', ...overrides }
}

const directories: string[] = []

function ownerLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'owner-conversation-ledger-'))
  directories.push(directory)
  return join(directory, 'session-host', 'owner-ledger.json')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SessionConversationLedgerStore (session parity, step 2)', () => {
  it('starts as an empty main set with no window publication', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    expect(store.snapshot()).toEqual({
      generation: store.generation,
      revision: 0,
      source: 'main',
      listedAt: 0,
      coverage: [],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [],
      projects: [],
      recordsByWorktree: {},
      removals: []
    })
    expect(store.lastWindowPublication()).toBeNull()
    expect(store.isWindowCurrent()).toBe(false)
    expect(store.getRendererGeneration()).toBeNull()
  })

  it('bumps its revision once per visible change to the window set and never on equal input', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const listener = vi.fn()
    store.onChange(listener)

    expect(store.publishWindow(publication({ [W]: [record('a')] }))).toBe(true)
    expect(store.snapshot()).toMatchObject({
      revision: 1,
      source: 'window',
      coverage: [{ worktreeId: W, complete: true }]
    })
    expect(store.isWindowCurrent()).toBe(true)
    // An identical republication — a renderer reload, a later listing time — is no change.
    expect(store.publishWindow(publication({ [W]: [record('a')] }))).toBe(false)
    const reloaded = publication({ [W]: [record('a')] }, { rendererGeneration: 'r2', listedAt: 9 })
    expect(store.publishWindow(reloaded)).toBe(false)
    expect(store.getRendererGeneration()).toBe('r2')
    expect(store.snapshot()).toMatchObject({ revision: 1, listedAt: 1_700_000_000_500 })
    // Records, coverage and folders each move it once.
    const live = [record('a', { rest: 'live' })]
    expect(store.publishWindow(publication({ [W]: live }))).toBe(true)
    const incomplete = { coverage: [{ worktreeId: W, complete: false }] }
    expect(store.publishWindow(publication({ [W]: live }, incomplete))).toBe(true)
    expect(store.publishWindow(publication({ [W]: live }, { ...incomplete, folders: [] }))).toBe(
      true
    )
    expect(store.snapshot().revision).toBe(4)
    expect(listener).toHaveBeenCalledTimes(4)
  })

  // The real wiring: step 3 builds its set once before the window attaches (app start), never while
  // a window publishes, and again a microtask after the window goes.
  it('never shows the main set built before the window once the window goes: its last listing stands', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    store.publishMain(mainSet({ [W]: [record('m'), record('closed-since')] }, { listedAt: 5 }))
    // The person closed one conversation meanwhile; the window's listing dropped it.
    store.publishWindow(publication({ [W]: [record('m'), record('w')] }))
    const revision = store.snapshot().revision

    store.markPublisherGone()
    expect(store.snapshot()).toMatchObject({
      revision: revision + 1,
      source: 'main',
      listedAt: 1_700_000_000_500,
      coverage: [{ worktreeId: W, complete: false }],
      recordsByWorktree: { [W]: [record('m'), record('w')] }
    })
    expect(store.isWindowCurrent()).toBe(false)
    expect(store.getRendererGeneration()).toBeNull()
    // Step 3's rebuild then shows at once.
    expect(store.publishMain(mainSet({ [W]: [record('m')] }))).toBe(true)
    expect(store.snapshot()).toMatchObject({
      revision: revision + 2,
      source: 'main',
      coverage: [{ worktreeId: W, complete: true }],
      recordsByWorktree: { [W]: [record('m')] }
    })
    // The window's own last publication stays readable for step 3's main-authored set.
    expect(store.lastWindowPublication()?.recordsByWorktree).toEqual({
      [W]: [record('m'), record('w')]
    })
  })

  it('without a main set falls back to the last window records with every workspace incomplete', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    store.publishWindow(publication({ [W]: [record('a')], [W2]: [record('b')] }))
    const listener = vi.fn()
    store.onChange(listener)

    store.markPublisherGone()
    expect(store.snapshot()).toMatchObject({
      revision: 2,
      source: 'main',
      coverage: [
        { worktreeId: W, complete: false },
        { worktreeId: W2, complete: false }
      ],
      recordsByWorktree: { [W]: [record('a')], [W2]: [record('b')] },
      folders: [{ id: 'f1', name: 'Church' }]
    })
    store.markPublisherGone()
    expect(listener).toHaveBeenCalledTimes(1)
    // With no window current a main set shows at once, until a window publishes again.
    expect(store.publishMain(mainSet({ [W]: [record('m')] }))).toBe(true)
    expect(store.snapshot()).toMatchObject({ revision: 3, source: 'main' })
    expect(store.publishWindow(publication({ [W]: [record('a')] }))).toBe(true)
    expect(store.snapshot()).toMatchObject({ revision: 4, source: 'window' })
  })

  it('stamps each new removal with the revision it first appears at; removalsSince returns only newer', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const a = { conversation: record('a').conversation!, worktreeId: W, at: 1 }
    const b = { paneIdentity: 'pane:tab-2:leaf-2', worktreeId: W, at: 2 }
    const c = { workflowTabId: 'flow-tab', worktreeId: W2, at: 3 }

    // This incarnation's first set; until it, no tombstone shows (see the next describe).
    store.publishWindow(publication({ [W]: [record('w')] }))
    expect(store.setRemovals([a], false)).toBe(true)
    expect(store.snapshot()).toMatchObject({ revision: 2, removals: [a] })
    expect(store.setRemovals([a, b, c], false)).toBe(true)
    expect(store.snapshot()).toMatchObject({ revision: 3, source: 'window', removals: [a, b, c] })
    expect(store.snapshot()).not.toHaveProperty('removalsTruncated')
    expect(store.removalsSince(0)).toEqual([a, b, c])
    expect(store.removalsSince(2)).toEqual([b, c])
    expect(store.removalsSince(3)).toEqual([])

    // The same tombstones in another order, or carrying stray keys, are no change.
    const withOpId = { ...a, opId: 'op-1' } as RuntimeSessionConversationRemoval
    expect(store.setRemovals([c, withOpId, b], false)).toBe(false)
    expect(store.snapshot().revision).toBe(3)
    // An undo (a cleared tombstone) and the cut marker are changes; survivors keep their stamps.
    expect(store.setRemovals([b, c], true)).toBe(true)
    expect(store.snapshot()).toMatchObject({
      revision: 4,
      removals: [b, c],
      removalsTruncated: true
    })
    expect(store.removalsSince(2)).toEqual([b, c])
    expect(store.removalsSince(3)).toEqual([])
    // A tombstone naming two conversations is dropped, never guessed at.
    expect(store.setRemovals([b, c, { ...a, paneIdentity: 'pane:x' }], true)).toBe(false)
    // Deleting the same conversation again (a new time) is a new tombstone.
    const again = { ...a, at: 9 }
    expect(store.setRemovals([b, c, again], false)).toBe(true)
    expect(store.removalsSince(4)).toEqual([again])
    expect(store.snapshot().removals).toEqual([b, c, again])
  })

  it('finds a shown record by its conversation digest or its pane identity', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const tab = record('t', {
      conversation: null,
      providerSession: null,
      paneIdentity: 'pane:tab-1:leaf-1',
      paneKey: 'tab-1:leaf-1',
      surface: 'tab'
    })
    store.publishWindow(publication({ [W]: [record('a'), tab] }))
    expect(store.findRecord(W, record('a').conversation!)).toEqual(record('a'))
    expect(store.findRecord(W, 'pane:tab-1:leaf-1')).toEqual(tab)
    expect(store.findRecord(W2, record('a').conversation!)).toBeNull()
    expect(store.findRecord(W, '')).toBeNull()
    expect(store.findRecord('__proto__', 'pane:tab-1:leaf-1')).toBeNull()
  })

  it('keeps each window publication on disk off the publish path and reads it back in a new store (F17)', async () => {
    const path = ownerLedgerPath()
    const first = new SessionConversationLedgerStore({ ownerLedgerPath: path })
    expect(first.lastWindowPublication()).toBeNull()
    first.publishWindow(publication({ [W]: [record('a')] }))
    const latest = publication({ [W]: [record('a'), record('b')] }, { listedAt: 1_700_000_009_000 })
    first.publishWindow(latest)
    // Why: the write is coalesced and asynchronous; publishWindow never waits for the disk.
    expect(existsSync(path)).toBe(false)
    await first.flushOwnerLedger()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, publication: latest })

    const next = new SessionConversationLedgerStore({ ownerLedgerPath: path })
    expect(next.generation).not.toBe(first.generation)
    expect(next.lastWindowPublication()).toEqual(latest)
    expect(next.isWindowCurrent()).toBe(false)
    // A cold start shows the kept listing as a main set that removes nothing.
    expect(next.snapshot()).toMatchObject({
      revision: 0,
      source: 'main',
      listedAt: latest.listedAt,
      coverage: [{ worktreeId: W, complete: false }],
      recordsByWorktree: latest.recordsByWorktree,
      folders: latest.folders,
      projects: latest.projects
    })
    // This incarnation's own window publication replaces the kept one.
    const fresh = publication({ [W2]: [record('c')] })
    next.publishWindow(fresh)
    expect(next.lastWindowPublication()).toBe(fresh)
    await next.flushOwnerLedger()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, publication: fresh })
  })

  it('sweeps an owner-ledger.json temp file an exit orphaned, sparing a fresh one', async () => {
    const path = ownerLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    const orphan = `${path}.1.1.abc.tmp`
    const fresh = `${path}.2.2.def.tmp`
    writeFileSync(orphan, '{}')
    writeFileSync(fresh, '{}')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(orphan, old, old)

    new SessionConversationLedgerStore({ ownerLedgerPath: path })

    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false))
    expect(existsSync(fresh)).toBe(true)
  })

  it('ignores a corrupt, foreign or missing file without throwing, and reads presentation only', () => {
    const path = ownerLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    for (const content of [
      'not json',
      'null',
      JSON.stringify({ v: 2, publication: publication({ [W]: [record('a')] }) }),
      JSON.stringify({ v: 1, publication: { recordsByWorktree: {} } })
    ]) {
      writeFileSync(path, content)
      const store = new SessionConversationLedgerStore({ ownerLedgerPath: path })
      expect(store.lastWindowPublication()).toBeNull()
      expect(store.snapshot()).toMatchObject({
        source: 'main',
        coverage: [],
        recordsByWorktree: {}
      })
    }
    const missing = join(dirname(path), 'missing.json')
    expect(
      new SessionConversationLedgerStore({ ownerLedgerPath: missing }).snapshot().revision
    ).toBe(0)

    const leaky = { ...record('a'), prompt: SENTINEL } as RuntimeSessionConversationRecord
    const tampered = publication({ [W]: [leaky] })
    writeFileSync(path, JSON.stringify({ v: 1, publication: tampered }))
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: path })
    expect(store.lastWindowPublication()?.recordsByWorktree[W]).toEqual([record('a')])
    expect(JSON.stringify(store.snapshot())).not.toContain(SENTINEL)
  })
})

const tombstone = (id: string, at = 1): RuntimeSessionConversationRemoval => ({
  conversation: record(id).conversation!,
  worktreeId: W,
  at
})
/** A deleted conversation whose tab is open again: the sidebar lists it. */
const reopened = (id: string) =>
  record(id, {
    surface: 'tab',
    tabId: `tab-${id}`,
    paneKey: `tab-${id}:leaf`,
    paneIdentity: `pane:tab-${id}:leaf`
  })

// Before this incarnation's first set no set has listed what it would hold back, and a receiver
// acts on a tombstone whatever the coverage, so none shows until then (session parity, integration).
describe('SessionConversationLedgerStore tombstones before its first set', () => {
  it('shows none, nor the cut marker, until the first window set, then the unlisted ones at its revision', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const listener = vi.fn()
    store.onChange(listener)

    expect(store.setRemovals([tombstone('a'), tombstone('b', 2)], true)).toBe(false)
    expect(store.snapshot()).toMatchObject({ revision: 0, removals: [] })
    expect(store.snapshot()).not.toHaveProperty('removalsTruncated')
    expect(store.removalsSince(0)).toEqual([])
    expect(listener).not.toHaveBeenCalled()

    expect(store.publishWindow(publication({ [W]: [reopened('a')] }))).toBe(true)
    expect(store.snapshot()).toMatchObject({
      revision: 1,
      source: 'window',
      removals: [tombstone('b', 2)],
      removalsTruncated: true
    })
    expect(store.removalsSince(0)).toEqual([tombstone('b', 2)])
    expect(store.removalsSince(1)).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('releases them at a first main-authored set too, even one that changes nothing else', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    store.setRemovals([tombstone('a')], false)
    const empty = mainSet({}, { folders: [], projects: [] })

    expect(store.publishMain(empty)).toBe(true)
    expect(store.snapshot()).toMatchObject({
      revision: 1,
      source: 'main',
      recordsByWorktree: {},
      removals: [tombstone('a')]
    })
    expect(store.removalsSince(0)).toEqual([tombstone('a')])
    // Released once: the same set again is no change.
    expect(store.publishMain(empty)).toBe(false)
    expect(store.snapshot().revision).toBe(1)
  })

  it('keeps them hidden behind the set kept on disk, which is no first set', async () => {
    const path = ownerLedgerPath()
    const before = new SessionConversationLedgerStore({ ownerLedgerPath: path })
    before.publishWindow(publication({ [W]: [record('c')] }))
    await before.flushOwnerLedger()

    const restarted = new SessionConversationLedgerStore({ ownerLedgerPath: path })
    expect(restarted.setRemovals([tombstone('a')], false)).toBe(false)
    restarted.markPublisherGone()
    expect(restarted.snapshot()).toMatchObject({
      revision: 0,
      source: 'main',
      recordsByWorktree: { [W]: [record('c')] },
      removals: []
    })
    expect(restarted.removalsSince(0)).toEqual([])

    expect(restarted.publishMain(mainSet({ [W]: [record('c')] }))).toBe(true)
    expect(restarted.snapshot()).toMatchObject({ revision: 1, removals: [tombstone('a')] })
    expect(restarted.removalsSince(0)).toEqual([tombstone('a')])
  })
})

// The durable delete mark outlives a reopened tab, which the sidebar lists again: listed evidence
// wins, so no snapshot lists and tombstones one conversation (session parity, integration).
describe('SessionConversationLedgerStore tombstones for a conversation the set lists', () => {
  it('holds a tombstone back from snapshots and deltas while a listed record names it', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    store.publishWindow(publication({ [W]: [reopened('a')] }))
    const listener = vi.fn()
    store.onChange(listener)

    expect(store.setRemovals([tombstone('a'), tombstone('b', 2)], false)).toBe(true)
    expect(store.snapshot()).toMatchObject({ revision: 2, removals: [tombstone('b', 2)] })
    expect(store.removalsSince(0)).toEqual([tombstone('b', 2)])
    // A change only to what is held back is no visible change.
    expect(store.setRemovals([tombstone('a', 5), tombstone('b', 2)], false)).toBe(false)
    expect(store.snapshot().revision).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('shows the tombstone again, new to every delta, once the row goes, and holds it back on reopen', () => {
    let now = 1_000
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null, now: () => now })
    store.publishWindow(publication({ [W]: [reopened('a'), record('c')] }))
    expect(store.setRemovals([tombstone('a')], false)).toBe(false)
    const base = store.snapshot().revision

    // The tab closes again: the deleted conversation is listed no more, as of now.
    now = 2_000
    expect(store.publishWindow(publication({ [W]: [record('c')] }))).toBe(true)
    const reshown = tombstone('a', 2_000)
    expect(store.snapshot()).toMatchObject({ revision: base + 1, removals: [reshown] })
    expect(store.removalsSince(base)).toEqual([reshown])
    expect(store.removalsSince(base + 1)).toEqual([])

    // Reopened once more, it is held back again; a main set listing it holds it back too.
    store.publishWindow(publication({ [W]: [reopened('a'), record('c')] }))
    expect(store.snapshot().removals).toEqual([])
    expect(store.removalsSince(0)).toEqual([])
    store.publishMain(mainSet({ [W]: [reopened('a')] }))
    store.markPublisherGone()
    expect(store.snapshot()).toMatchObject({ source: 'main', removals: [] })
    now = 3_000
    store.publishMain(mainSet({ [W]: [record('c')] }))
    expect(store.snapshot().removals).toEqual([tombstone('a', 3_000)])
  })

  // F4 for a re-hide: deleted long ago, resumed, its tab closed today — a peer that missed the
  // window's set must still get the tombstone, so it runs from the moment it showed again.
  it('dates a tombstone shown again by that moment and keeps it 90 days from it, however old the delete', () => {
    const day = 24 * 60 * 60 * 1000
    let now = Date.UTC(2026, 9, 6)
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null, now: () => now })
    const old = tombstone('a', now - 100 * day)
    store.publishWindow(publication({ [W]: [reopened('a'), record('c')] }))
    // Past retention by its stamp, the provider hands it over as aged; a listed record holds it.
    expect(store.setRemovals([], false, [old])).toBe(false)
    expect(store.setRemovals([], false, [tombstone('b', now - 100 * day)])).toBe(false)
    expect(store.setRemovals([], false, [old])).toBe(false)

    now += 1_000
    const reshownAt = now
    expect(store.publishWindow(publication({ [W]: [record('c')] }))).toBe(true)
    expect(store.snapshot().removals).toEqual([{ ...old, at: reshownAt }])
    // The provider's next lists keep it until 90 days from that moment, then it goes.
    now += 89 * day
    expect(store.setRemovals([], false, [old])).toBe(false)
    expect(store.snapshot().removals).toEqual([{ ...old, at: reshownAt }])
    now += 2 * day
    expect(store.setRemovals([], false, [old])).toBe(true)
    expect(store.snapshot().removals).toEqual([])
  })

  it('matches either identity in the same workspace; passive evidence holds nothing back', () => {
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const providerless = record('p', {
      conversation: null,
      providerSession: null,
      surface: 'tab',
      paneKey: 'tab-p:leaf',
      paneIdentity: 'pane:tab-p:leaf'
    })
    store.publishWindow(
      publication({ [W]: [providerless, reopened('r'), record('d', { listed: false })] })
    )
    const elsewhere = { ...tombstone('r', 7), worktreeId: W2 }
    store.setRemovals(
      [
        { paneIdentity: 'pane:tab-p:leaf', worktreeId: W, at: 3 },
        { paneIdentity: 'pane:tab-r:leaf', worktreeId: W, at: 4 },
        tombstone('r', 5),
        tombstone('d', 6),
        elsewhere
      ],
      false
    )
    expect(store.snapshot().removals).toEqual([tombstone('d', 6), elsewhere])
    // With no window the last records still stand, so they still hold theirs back.
    store.markPublisherGone()
    expect(store.snapshot()).toMatchObject({
      source: 'main',
      removals: [tombstone('d', 6), elsewhere]
    })
  })
})
