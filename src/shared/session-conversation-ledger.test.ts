import { describe, expect, it } from 'vitest'
import { getProviderSessionClaimKey } from './provider-session-claim-key'
import { providerSessionFolderKey } from './session-folder-identity'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import {
  SESSION_CONVERSATION_LEDGER_EVENT,
  SESSION_CONVERSATION_LEDGER_LIMITS,
  SESSION_CONVERSATION_LEDGER_SYNC_CHANNEL,
  isSessionConversationIdentity,
  readSessionConversationLedger,
  readSessionConversationLedgerDelta,
  readSessionConversationLedgerPublication,
  readSessionConversationRecord,
  readSessionConversationRemoval,
  sessionConversationIdentity,
  sessionConversationIdentityFromClaimKey,
  sessionConversationIdentityFromProviderKey,
  sessionConversationPaneIdentity,
  sessionConversationListedRemovalKeys,
  sessionConversationRecordIdentity,
  sessionConversationRemovalKey
} from './session-conversation-ledger'

const W = 'c1438ef4-1bb1-4b73-a5f2-cf72b9924c5f::/Users/maintainer/omni-ide-worktrees/omni-ide/x'
const W2 = 'folder:studio-folder'
/** Never on the wire: placed in every forbidden place, then searched for in every serialization. */
const SENTINEL = 'SENTINEL-never-on-the-wire-7f3a9c'
const FORBIDDEN_KEYS =
  /"(prompt|launchConfig|agentArgs|agentEnv|transcriptPath|lastAssistantMessage|settings|verifiedFallback)"/

/** A record as the owner publishes it: `conversation` is the digest of its own full claim. */
function record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const agent = typeof overrides.agent === 'string' ? overrides.agent : 'claude'
  const providerSession =
    'providerSession' in overrides
      ? (overrides.providerSession as AgentProviderSessionMetadata | null)
      : { key: 'session_id' as const, id }
  return {
    conversation: sessionConversationIdentity({ worktreeId: W, agent, providerSession }),
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    title: `Claude ${id}`,
    titleSource: 'terminal',
    surface: 'record',
    rest: 'asleep',
    listed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function ledger(
  recordsByWorktree: Record<string, unknown[]>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    generation: 'g1',
    revision: 3,
    source: 'window',
    listedAt: 1_700_000_000_500,
    coverage: Object.keys(recordsByWorktree).map((worktreeId) => ({ worktreeId, complete: true })),
    omitted: { unknownHost: 0, unverified: 1 },
    folders: [{ id: 'f1', name: 'Church', section: 'saved' }],
    projects: [{ folderId: 'f1', displayName: 'Church' }],
    recordsByWorktree,
    ...overrides
  }
}

function many(count: number, prefix = 's'): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => record(`${prefix}-${index}`))
}

describe('conversation identity (F1: the full owner claim, opaque on the wire, host-free)', () => {
  const pi = {
    worktreeId: W,
    agent: 'pi',
    providerSession: {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: `/Users/maintainer/.pi/${SENTINEL}.jsonl`
    }
  }

  it('is one 24-hex digest of the full claim for the owner’s local key, a peer’s runtime key and the record', () => {
    const fromLocal = sessionConversationIdentityFromProviderKey(
      providerSessionFolderKey({ hostId: 'local', ...pi })
    )
    const fromPeer = sessionConversationIdentityFromProviderKey(
      providerSessionFolderKey({ hostId: 'runtime:x', ...pi })
    )
    const expected = sessionConversationIdentity(pi)
    expect(expected).toMatch(/^[0-9a-f]{24}$/)
    expect(expected).toBe(sessionConversationIdentityFromClaimKey(getProviderSessionClaimKey(pi)))
    expect(fromLocal).toEqual({ worktreeId: W, conversation: expected })
    expect(fromPeer).toEqual(fromLocal)
    // Why: the claim key carries the transcript path; the digest covers it without exposing it.
    expect(getProviderSessionClaimKey(pi)).toContain(SENTINEL)
    expect(expected).not.toContain(SENTINEL)
    expect(readSessionConversationRecord(record('pi-session-1', pi))).toMatchObject({
      conversation: expected
    })
  })

  it('tells two Pi (or Prime Agent) conversations apart by transcript when they share a session id', () => {
    const other = {
      ...pi,
      providerSession: {
        ...pi.providerSession,
        transcriptPath: '/Users/maintainer/.pi/other.jsonl'
      }
    }
    expect(sessionConversationIdentity(other)).not.toBe(sessionConversationIdentity(pi))
    expect(
      sessionConversationIdentityFromProviderKey(
        providerSessionFolderKey({ hostId: 'local', ...other })
      )
    ).not.toEqual(
      sessionConversationIdentityFromProviderKey(
        providerSessionFolderKey({ hostId: 'local', ...pi })
      )
    )
    expect(sessionConversationIdentity({ ...other, agent: 'prime-agent' })).not.toBe(
      sessionConversationIdentity({ ...pi, agent: 'prime-agent' })
    )
    // Why: for every other agent the claim key has no transcript part, so the path changes nothing.
    const claude = { ...pi, agent: 'claude' }
    expect(
      sessionConversationIdentity({
        ...claude,
        providerSession: { key: 'session_id', id: 'pi-session-1' }
      })
    ).toBe(sessionConversationIdentity(claude))
  })

  it('separates workspaces, agents and ids, and is null until a provider session exists', () => {
    const base = {
      worktreeId: W,
      agent: 'claude',
      providerSession: { key: 'session_id' as const, id: 'same' }
    }
    const claude = sessionConversationIdentity(base)
    expect(sessionConversationIdentity({ ...base, worktreeId: W2 })).not.toBe(claude)
    expect(sessionConversationIdentity({ ...base, agent: 'codex' })).not.toBe(claude)
    expect(
      sessionConversationIdentity({ ...base, providerSession: { key: 'session_id', id: 'other' } })
    ).not.toBe(claude)
    expect(sessionConversationIdentity({ ...base, providerSession: null })).toBeNull()
    expect(sessionConversationIdentity({ ...base, agent: '' })).toBeNull()
    expect(sessionConversationIdentity({ ...base, worktreeId: '' })).toBeNull()
    expect(isSessionConversationIdentity(claude)).toBe(true)
    expect(isSessionConversationIdentity(`${claude}0`)).toBe(false)
    expect(isSessionConversationIdentity(claude!.toUpperCase())).toBe(false)
  })

  it('keeps a valid sent digest as is and reads a non-hex one as no identity', () => {
    const sent = 'abcdef0123456789abcdef01'
    // Why: the reader cannot rebuild the owner's full-claim digest, so it never overwrites one.
    expect(readSessionConversationRecord(record('a', { conversation: sent }))).toMatchObject({
      conversation: sent
    })
    expect(readSessionConversationRecord(record('a', { conversation: 'not-a-digest' }))).toBeNull()
    expect(
      readSessionConversationRecord(record('a', { conversation: sent.toUpperCase() }))
    ).toBeNull()
    expect(
      readSessionConversationRecord(record('a', { conversation: 42, paneKey: 'tab-2:leaf-2' }))
    ).toMatchObject({ conversation: null, paneIdentity: 'pane:tab-2:leaf-2' })
  })

  it('reads nothing from a structured, pane or malformed key', () => {
    expect(
      sessionConversationIdentityFromProviderKey(JSON.stringify(['local', 'structured', 'id']))
    ).toBeNull()
    expect(
      sessionConversationIdentityFromProviderKey(JSON.stringify(['local', 'pane', W, 'p']))
    ).toBeNull()
    expect(sessionConversationIdentityFromProviderKey('not json')).toBeNull()
    expect(
      sessionConversationIdentityFromProviderKey(
        JSON.stringify(['local', 'provider', `${W}\0claude`])
      )
    ).toBeNull()
  })

  it('folds a provider-less tab record by its pane, and keeps identity on a listed:false record', () => {
    const tab = readSessionConversationRecord(
      record('ignored', {
        providerSession: null,
        surface: 'tab',
        paneKey: 'tab-1:leaf-1',
        tabId: 'tab-1'
      })
    )
    expect(tab).toMatchObject({
      conversation: null,
      paneIdentity: sessionConversationPaneIdentity('tab-1:leaf-1'),
      surface: 'tab',
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1'
    })
    expect(sessionConversationRecordIdentity(tab!)).toBe('pane:tab-1:leaf-1')

    const passive = readSessionConversationRecord(record('held', { listed: false }))
    expect(passive).toMatchObject({
      listed: false,
      conversation: sessionConversationIdentity({
        worktreeId: W,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'held' }
      })
    })
    expect(sessionConversationRecordIdentity(passive!)).toBe(passive!.conversation)
  })
})

describe('readSessionConversationRecord', () => {
  it('degrades unknown vocabulary to the reading that asserts least', () => {
    expect(
      readSessionConversationRecord(
        record('v', {
          rest: 'hibernating',
          surface: 'pane',
          titleSource: 'prompt',
          title: 'x'.repeat(250)
        })
      )
    ).toMatchObject({
      rest: 'unknown',
      surface: 'record',
      titleSource: 'generated',
      title: 'x'.repeat(200)
    })
  })

  it('keeps organization state tri-state (A2): explicit values pass, anything else is unknown', () => {
    const explicit = readSessionConversationRecord(
      record('o', {
        archived: { archived: false },
        folderId: null,
        saved: false,
        hidden: true,
        interrupted: true
      })
    )
    expect(explicit).toMatchObject({
      archived: { archived: false },
      folderId: null,
      saved: false,
      hidden: true,
      interrupted: true
    })
    expect(explicit!.archived).not.toHaveProperty('byHand')

    const byHand = readSessionConversationRecord(
      record('h', { archived: { archived: true, byHand: true } })
    )
    expect(byHand!.archived).toEqual({ archived: true, byHand: true })

    const unknown = readSessionConversationRecord(
      record('u', { archived: true, hidden: 'yes', saved: 1, interrupted: 'no', listed: undefined })
    )
    expect(unknown).not.toHaveProperty('archived')
    expect(unknown).not.toHaveProperty('folderId')
    expect(unknown).not.toHaveProperty('hidden')
    expect(unknown).not.toHaveProperty('saved')
    expect(unknown).not.toHaveProperty('interrupted')
    // Why: a missing flag must not hide a conversation the owner shows.
    expect(unknown!.listed).toBe(true)
  })

  it('drops a record only when it has neither a digest nor a pane; an unknown provider key reads null', () => {
    expect(readSessionConversationRecord({ agent: 'claude', title: 'no identity' })).toBeNull()
    expect(
      readSessionConversationRecord(record('k', { conversation: null, paneKey: 'tab-9:leaf-9' }))
    ).toMatchObject({ conversation: null, paneIdentity: 'pane:tab-9:leaf-9' })
    const digest = sessionConversationIdentity({
      worktreeId: W,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'k' }
    })
    // Why: the digest is the identity; unreadable components only lose the components.
    expect(
      readSessionConversationRecord(
        record('k', { conversation: digest, providerSession: { key: 'thread_id', id: 'k' } })
      )
    ).toMatchObject({ conversation: digest, providerSession: null })
    expect(readSessionConversationRecord('a string')).toBeNull()
  })
})

describe('readSessionConversationLedger', () => {
  it('caps a workspace at 1000 records, names it and marks only its coverage incomplete', () => {
    const read = readSessionConversationLedger(ledger({ [W]: many(1001), [W2]: many(2, 't') }))!
    expect(read.recordsByWorktree[W]).toHaveLength(1000)
    expect(read.recordsByWorktree[W2]).toHaveLength(2)
    expect(read.truncatedWorktrees).toEqual([W])
    expect(read.coverage).toEqual([
      { worktreeId: W, complete: false },
      { worktreeId: W2, complete: true }
    ])
  })

  it('cuts at 8000 records in total and names every workspace it cut', () => {
    const recordsByWorktree = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`${W2}-${index}`, many(1000, `w${index}`)])
    )
    const read = readSessionConversationLedger(ledger(recordsByWorktree))!
    const total = Object.values(read.recordsByWorktree).reduce((sum, list) => sum + list.length, 0)
    expect(total).toBe(8000)
    expect(read.truncatedWorktrees).toEqual([`${W2}-8`])
    expect(read.coverage.find((entry) => entry.worktreeId === `${W2}-8`)).toEqual({
      worktreeId: `${W2}-8`,
      complete: false
    })
    expect(read.coverage.filter((entry) => entry.complete)).toHaveLength(8)
  })

  it('reads a dropped or duplicate record as incomplete coverage for that workspace alone', () => {
    const read = readSessionConversationLedger(
      ledger({
        [W]: [
          record('a'),
          { agent: 'claude', title: 'identity-less' },
          record('a', { title: 'twin' })
        ],
        [W2]: [record('b')]
      })
    )!
    expect(read.recordsByWorktree[W]!.map((entry) => entry.title)).toEqual(['Claude a'])
    expect(read.truncatedWorktrees).toBeUndefined()
    expect(read.coverage).toEqual([
      { worktreeId: W, complete: false },
      { worktreeId: W2, complete: true }
    ])
  })

  it('counts the records of a bucket whose workspace id is too long as omitted, never silently', () => {
    const long = `repo::/${'x'.repeat(SESSION_CONVERSATION_LEDGER_LIMITS.worktreeId)}`
    const sent = ledger({ [W]: [record('a')], [long]: [record('b'), record('c')] })
    const read = readSessionConversationLedger(sent)!
    expect(Object.keys(read.recordsByWorktree)).toEqual([W])
    expect(read.coverage).toEqual([{ worktreeId: W, complete: true }])
    // The owner said one; the two the bucket held join it.
    expect(read.omitted).toEqual({ unknownHost: 0, unverified: 3 })
    expect(
      readSessionConversationLedgerPublication({ ...sent, rendererGeneration: 'r1' })?.omitted
    ).toEqual({ unknownHost: 0, unverified: 3 })
  })

  it('names every bucket in coverage even when the owner’s list omits it, never as complete', () => {
    const read = readSessionConversationLedger(
      ledger({ [W]: [record('a')] }, { coverage: [{ worktreeId: W2, complete: true }, 'junk'] })
    )!
    expect(read.coverage).toEqual([
      { worktreeId: W2, complete: true },
      { worktreeId: W, complete: false }
    ])
  })

  it('never emits a sentinel placed in a prompt, launch config, project setting, attachment or transcript path (A6)', () => {
    const leaky = ledger(
      {
        [W]: [
          record('leak', {
            prompt: SENTINEL,
            launchConfig: { agentArgs: SENTINEL, agentEnv: { OPENAI_API_KEY: SENTINEL } },
            agentArgs: SENTINEL,
            agentEnv: { TOKEN: SENTINEL },
            lastAssistantMessage: SENTINEL,
            transcriptPath: `/Users/maintainer/${SENTINEL}`,
            providerSession: {
              key: 'session_id',
              id: 'leak',
              transcriptPath: `/Users/maintainer/.claude/${SENTINEL}.jsonl`,
              verifiedFallback: { key: 'session_id', id: 'leak', transcriptPath: SENTINEL }
            }
          }),
          record('pi', {
            agent: 'pi',
            providerSession: { key: 'session_id', id: 'pi', transcriptPath: SENTINEL }
          })
        ]
      },
      {
        debug: SENTINEL,
        removals: [{ paneIdentity: 'pane:tab-5:leaf-5', worktreeId: W, at: 1, opId: SENTINEL }],
        folders: [{ id: 'f1', name: 'Church', notes: SENTINEL }],
        projects: [
          {
            folderId: 'f1',
            displayName: 'Church',
            settings: {
              agents: [{ instructions: SENTINEL }],
              attachments: [{ kind: 'inline', content: SENTINEL }]
            }
          }
        ]
      }
    )
    const asSet = JSON.stringify(readSessionConversationLedger(leaky))
    const asDelta = JSON.stringify(
      readSessionConversationLedgerDelta({
        ...leaky,
        baseRevision: 2,
        changedByWorktree: leaky.recordsByWorktree
      })
    )
    const asPublication = JSON.stringify(
      readSessionConversationLedgerPublication({ ...leaky, rendererGeneration: 'r1' })
    )
    for (const serialized of [asSet, asDelta, asPublication]) {
      expect(serialized).not.toContain(SENTINEL)
      expect(serialized).not.toMatch(FORBIDDEN_KEYS)
      expect(serialized).toContain('Claude leak')
    }
    expect(readSessionConversationLedger(leaky)!.projects).toEqual([
      { folderId: 'f1', displayName: 'Church' }
    ])
  })

  it('reads an unknown source as main and refuses a set without generation or revision', () => {
    expect(
      readSessionConversationLedger(ledger({ [W]: [record('a')] }, { source: 'renderer' }))
    ).toMatchObject({
      source: 'main',
      omitted: { unknownHost: 0, unverified: 1 },
      listedAt: 1_700_000_000_500
    })
    expect(readSessionConversationLedger(ledger({}, { generation: '' }))).toBeUndefined()
    expect(readSessionConversationLedger(ledger({}, { revision: -1 }))).toBeUndefined()
    expect(readSessionConversationLedger(ledger({}, { recordsByWorktree: [] }))).toBeUndefined()
    expect(readSessionConversationLedger(null)).toBeUndefined()
  })

  it('bounds folders and projects at 500, trims names to 80 and reads the folder section', () => {
    const read = readSessionConversationLedger(
      ledger(
        {},
        {
          folders: [
            { id: 'long', name: ` ${'n'.repeat(100)} `, parentId: 'p', section: 'active' },
            { id: 'bad-section', name: 'ok', section: 'pinned' },
            { id: 'nameless', name: '  ' },
            ...Array.from({ length: 600 }, (_, index) => ({ id: `f-${index}`, name: `F ${index}` }))
          ],
          projects: [
            { folderId: 'long', displayName: 'd'.repeat(100) },
            { folderId: 'long' },
            ...Array.from({ length: 600 }, (_, index) => ({ folderId: `f-${index}` }))
          ]
        }
      )
    )!
    // Why 499: the cap bounds the entries examined (the first 500); one of them was nameless.
    expect(read.folders).toHaveLength(499)
    expect(read.folders[0]).toEqual({
      id: 'long',
      name: 'n'.repeat(80),
      parentId: 'p',
      section: 'active'
    })
    expect(read.folders[1]).toEqual({ id: 'bad-section', name: 'ok' })
    expect(read.folders.some((folder) => folder.id === 'nameless')).toBe(false)
    expect(read.folders.at(-1)).toEqual({ id: 'f-496', name: 'F 496' })
    // Why 499: the first 500 entries held one duplicate project folder.
    expect(read.projects).toHaveLength(499)
    expect(read.projects[0]).toEqual({ folderId: 'long', displayName: 'd'.repeat(80) })
  })
})

describe('readSessionConversationLedgerDelta', () => {
  const base = { generation: 'g1', revision: 4, baseRevision: 3, source: 'window' }

  it('replaces whole workspace buckets: an emptied bucket stays [] and every changed one is covered', () => {
    const read = readSessionConversationLedgerDelta({
      ...base,
      coverage: [{ worktreeId: W2, complete: true }],
      changedByWorktree: { [W]: [], [W2]: [record('b')] }
    })!
    expect(read.changedByWorktree[W]).toEqual([])
    expect(read.changedByWorktree[W2]).toHaveLength(1)
    // Why: a changed workspace the owner did not cover reads incomplete, so nothing is removed from it.
    expect(read.coverage).toEqual([
      { worktreeId: W2, complete: true },
      { worktreeId: W, complete: false }
    ])
    expect(read).not.toHaveProperty('folders')
    expect(read).not.toHaveProperty('projects')
  })

  it('marks a bucket with a dropped or cut record incomplete and still delivers what it read', () => {
    const read = readSessionConversationLedgerDelta({
      ...base,
      coverage: [
        { worktreeId: W, complete: true },
        { worktreeId: W2, complete: true }
      ],
      changedByWorktree: { [W]: [record('a'), 'junk'], [W2]: many(1001) }
    })!
    expect(read.changedByWorktree[W]).toHaveLength(1)
    expect(read.changedByWorktree[W2]).toHaveLength(1000)
    expect(read.coverage).toEqual([
      { worktreeId: W, complete: false },
      { worktreeId: W2, complete: false }
    ])
  })

  it('carries folders and projects only when the owner sent them (A4)', () => {
    const read = readSessionConversationLedgerDelta({
      ...base,
      coverage: [],
      changedByWorktree: {},
      folders: [],
      projects: [{ folderId: 'f1' }]
    })!
    expect(read.folders).toEqual([])
    expect(read.projects).toEqual([{ folderId: 'f1' }])
  })

  it('refuses a delta without a base revision or a readable bucket map', () => {
    expect(
      readSessionConversationLedgerDelta({
        ...base,
        baseRevision: undefined,
        coverage: [],
        changedByWorktree: {}
      })
    ).toBeUndefined()
    expect(
      readSessionConversationLedgerDelta({ ...base, coverage: [], changedByWorktree: [] })
    ).toBeUndefined()
  })
})

describe('removals: deletion tombstones (F4, F15)', () => {
  const digest = sessionConversationIdentity({
    worktreeId: W,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'deleted' }
  })!
  const byConversation = { conversation: digest, worktreeId: W, at: 1_700_000_001_000 }
  const byPane = { paneIdentity: 'pane:tab-3:leaf-3', worktreeId: W, at: 1_700_000_002_000 }
  const byWorkflow = { workflowTabId: 'flow-tab', worktreeId: W2, at: 1_700_000_003_000 }
  const deltaBase = {
    generation: 'g1',
    revision: 5,
    baseRevision: 4,
    source: 'main',
    coverage: [],
    changedByWorktree: {}
  }

  it('accepts each identity kind alone — a pane-only or workflow-only one too — with known keys only', () => {
    expect(readSessionConversationRemoval(byConversation)).toEqual(byConversation)
    expect(readSessionConversationRemoval(byPane)).toEqual(byPane)
    expect(readSessionConversationRemoval(byWorkflow)).toEqual(byWorkflow)
    // Why: records send `conversation: null` for "none"; it is not a second identity.
    expect(readSessionConversationRemoval({ ...byPane, conversation: null })).toEqual(byPane)
    expect(
      readSessionConversationRemoval({ ...byConversation, opId: 'op-1', prompt: SENTINEL })
    ).toEqual(byConversation)
  })

  it('drops an entry naming no conversation or several, or lacking a workspace or a finite time', () => {
    for (const entry of [
      { worktreeId: W, at: 1 },
      { ...byConversation, paneIdentity: byPane.paneIdentity },
      { ...byPane, workflowTabId: 'flow-tab' },
      { ...byConversation, workflowTabId: 'flow-tab' },
      { ...byConversation, conversation: 'not-a-digest' },
      { ...byPane, paneIdentity: 'tab-3:leaf-3' },
      { ...byPane, paneIdentity: 'pane:' },
      { ...byWorkflow, workflowTabId: 'x'.repeat(201) },
      { ...byWorkflow, workflowTabId: '' },
      { ...byConversation, worktreeId: '' },
      { conversation: digest, at: 1 },
      { ...byConversation, at: Number.NaN },
      { ...byConversation, at: Number.POSITIVE_INFINITY },
      { ...byConversation, at: '1700000001000' },
      'junk',
      null
    ]) {
      expect(readSessionConversationRemoval(entry)).toBeNull()
    }
    const read = readSessionConversationLedger(
      ledger({}, { removals: [byPane, { ...byPane, workflowTabId: 'flow-tab' }, byPane] })
    )!
    // Why: an exact repeat is the same deletion; a dropped entry removes nothing and cuts nothing.
    expect(read.removals).toEqual([byPane])
    expect(read).not.toHaveProperty('removalsTruncated')
  })

  it('caps at 2000 keeping the newest by time, in sent order, and marks the cut on a set and a delta', () => {
    const limit = SESSION_CONVERSATION_LEDGER_LIMITS.removals
    expect(limit).toBe(2000)
    // Why the oldest sits mid-list: the cap keeps by time, not by position.
    const removals = Array.from({ length: limit + 1 }, (_, index) => ({
      workflowTabId: `flow-${index}`,
      worktreeId: W,
      at: index === 1000 ? 0 : 10_000 + index
    }))
    const set = readSessionConversationLedger(ledger({}, { removals }))!
    expect(set.removals).toHaveLength(limit)
    expect(set.removalsTruncated).toBe(true)
    expect(set.removals.some((removal) => removal.workflowTabId === 'flow-1000')).toBe(false)
    expect(set.removals[0]).toEqual(removals[0])
    expect(set.removals.at(-1)).toEqual(removals.at(-1))
    const delta = readSessionConversationLedgerDelta({ ...deltaBase, removals })!
    expect(delta.removals).toHaveLength(limit)
    expect(delta.removalsTruncated).toBe(true)
  })

  it('round trips through a set and a delta; the window publication carries none', () => {
    const removals = [byConversation, byPane, byWorkflow]
    const set = readSessionConversationLedger(
      ledger({ [W]: [record('a')] }, { source: 'main', removals })
    )!
    expect(set.removals).toEqual(removals)
    expect(set).not.toHaveProperty('removalsTruncated')
    expect(readSessionConversationLedger(JSON.parse(JSON.stringify(set)))).toEqual(set)

    const delta = readSessionConversationLedgerDelta({ ...deltaBase, removals: [byWorkflow] })!
    expect(delta.removals).toEqual([byWorkflow])
    expect(readSessionConversationLedgerDelta(JSON.parse(JSON.stringify(delta)))).toEqual(delta)
    // Why: absent on a delta means no removal since its base; absent on a set reads as none.
    expect(readSessionConversationLedgerDelta(deltaBase)).not.toHaveProperty('removals')
    expect(readSessionConversationLedger(ledger({}))!.removals).toEqual([])
    // Why: main authors every tombstone from durable owner state; a window never sends one.
    expect(
      readSessionConversationLedgerPublication({
        ...ledger({}, { removals }),
        rendererGeneration: 'r1'
      })
    ).not.toHaveProperty('removals')
  })

  it('keeps the owner’s truncation marker on a set and a delta, and only a literal true', () => {
    expect(
      readSessionConversationLedger(ledger({}, { removals: [byPane], removalsTruncated: true }))
    ).toMatchObject({ removals: [byPane], removalsTruncated: true })
    expect(
      readSessionConversationLedger(ledger({}, { removalsTruncated: 'yes' }))
    ).not.toHaveProperty('removalsTruncated')
    expect(
      readSessionConversationLedgerDelta({ ...deltaBase, removalsTruncated: true })
    ).toMatchObject({ removalsTruncated: true })
  })

  it('keys a tombstone by identity kind and workspace, never by its time', () => {
    const key = sessionConversationRemovalKey(byConversation)
    const later = { ...byConversation, at: byConversation.at + 1 }
    expect(key).toBe(JSON.stringify([`c:${digest}`, W]))
    expect(sessionConversationRemovalKey(later)).toBe(key)
    expect(sessionConversationRemovalKey({ conversation: digest, worktreeId: W })).toBe(key)
    expect(sessionConversationRemovalKey({ conversation: digest, worktreeId: W2 })).not.toBe(key)
    expect(sessionConversationRemovalKey(byPane)).toBe(
      JSON.stringify([`p:${byPane.paneIdentity}`, W])
    )
    expect(sessionConversationRemovalKey(byWorkflow)).toBe(JSON.stringify(['w:flow-tab', W2]))
    // Why: equal text under another identity kind is another conversation.
    expect(sessionConversationRemovalKey({ workflowTabId: 'pane:x', worktreeId: W })).not.toBe(
      sessionConversationRemovalKey({ paneIdentity: 'pane:x', worktreeId: W })
    )
    expect(sessionConversationRemovalKey({ worktreeId: W })).toBe('')
  })

  it('lets a listed record shield both of its identities in its workspace, and passive evidence none', () => {
    const shielded = sessionConversationListedRemovalKeys({
      [W]: [
        { conversation: digest, paneIdentity: byPane.paneIdentity, listed: true },
        { conversation: null, paneIdentity: 'pane:tab-9:leaf-9', listed: true },
        { conversation: '0123456789abcdef01234567', listed: false }
      ]
    })
    expect(shielded.has(sessionConversationRemovalKey(byConversation))).toBe(true)
    expect(shielded.has(sessionConversationRemovalKey(byPane))).toBe(true)
    expect(
      shielded.has(
        sessionConversationRemovalKey({ paneIdentity: 'pane:tab-9:leaf-9', worktreeId: W })
      )
    ).toBe(true)
    expect(
      shielded.has(
        sessionConversationRemovalKey({ conversation: '0123456789abcdef01234567', worktreeId: W })
      )
    ).toBe(false)
    expect(shielded.has(sessionConversationRemovalKey({ ...byConversation, worktreeId: W2 }))).toBe(
      false
    )
    expect(shielded.size).toBe(3)
  })
})

describe('readSessionConversationLedgerPublication', () => {
  it('requires the renderer generation and validates the body like a set', () => {
    const body = ledger({ [W]: [record('a'), { title: 'identity-less' }] })
    expect(readSessionConversationLedgerPublication(body)).toBeNull()
    const read = readSessionConversationLedgerPublication({ ...body, rendererGeneration: 'r1' })!
    expect(read).toMatchObject({
      rendererGeneration: 'r1',
      listedAt: 1_700_000_000_500,
      coverage: [{ worktreeId: W, complete: false }],
      folders: [{ id: 'f1', name: 'Church', section: 'saved' }],
      projects: [{ folderId: 'f1', displayName: 'Church' }]
    })
    expect(read).not.toHaveProperty('generation')
    expect(read.recordsByWorktree[W]).toHaveLength(1)
  })

  it('names the wire event and the window-to-main channel', () => {
    expect(SESSION_CONVERSATION_LEDGER_EVENT).toBe('conversationLedger')
    expect(SESSION_CONVERSATION_LEDGER_SYNC_CHANNEL).toBe('runtime:syncSessionConversationLedger')
  })
})
