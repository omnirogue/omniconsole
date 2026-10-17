import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const graph = vi.hoisted(() => ({ listeners: new Set<() => void>() }))
vi.mock('./sync-runtime-graph', () => ({
  getRuntimeGraphRendererGeneration: () => 'renderer:test',
  onRuntimeGraphSynced: (listener: () => void) => {
    graph.listeners.add(listener)
    return () => graph.listeners.delete(listener)
  }
}))

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { conversationViewKey } from '@/lib/conversation-view'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView, type SessionSidebarView } from '@/lib/session-sidebar-view'
import { livePtyIdForSessionPane } from '@/lib/session-sleep-target'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from '@/lib/sidebar-session-test-fixtures'
import { buildSidebarSessions, type SidebarSessionSource } from '@/lib/sidebar-sessions'
import { deriveGeneratedTabTitle } from '../../../shared/agent-tab-title'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { emptyProjectSettings } from '../../../shared/project-settings'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  readSessionConversationLedgerPublication,
  sessionConversationIdentity,
  sessionConversationIdentityFromProviderKey,
  sessionConversationListedRemovalKeys,
  sessionConversationPaneIdentity,
  sessionConversationRemovalKey,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval,
  type SessionConversationLedgerWindowPublication
} from '../../../shared/session-conversation-ledger'
import { sessionOwnerTitle } from '../../../shared/session-owner-title'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { LivePtyCensusApi } from './live-pty-census'
import {
  buildSessionConversationLedger,
  selectConversationLedgerEligibility,
  startSessionConversationLedgerPublication
} from './session-conversation-ledger-publication'

const WT = SESSION_TEST_WORKTREE
const LEAF = SESSION_TEST_LEAF
const FOLDER = '00000000-0000-4000-8000-00000000000a'
const SENTINEL = 'SENTINEL-7f3a'

type TestState = SidebarSessionSource & {
  ptyIdsByTabId: Record<string, string[]>
  hydrationSucceeded: boolean
  terminalStartupRestorationReady: boolean
}

function emptyState(): TestState {
  return {
    ...sessionTestSource(),
    ptyIdsByTabId: {},
    hydrationSucceeded: true,
    terminalStartupRestorationReady: true
  }
}

const asApp = (state: TestState): AppState => state as unknown as AppState
const pane = (tabId: string): string => makePaneKey(tabId, LEAF)
const noFolders = (): SessionFolderMetadata => ({ version: 1, folders: [], membership: {} })

/** As startup reconnect does: the saved layout's leaf PTY is advertised as the tab's PTY. */
function bindPty(state: TestState, tabId: string, ptyId: string): void {
  state.terminalLayoutsByTabId[tabId] = {
    ...state.terminalLayoutsByTabId[tabId]!,
    ptyIdsByLeafId: { [LEAF]: ptyId }
  }
  state.ptyIdsByTabId[tabId] = [ptyId]
}

/** A claude tab whose agent reported `providerId`; its PTY bound as `ptyId` when given. */
function agentTab(state: TestState, tabId: string, providerId: string, ptyId?: string) {
  const tab = addSessionTestTab(state, tabId)
  tab.launchAgent = 'claude'
  state.agentStatusByPaneKey[pane(tabId)] = {
    paneKey: pane(tabId),
    tabId,
    worktreeId: WT,
    agentType: 'claude',
    state: 'working',
    prompt: `${SENTINEL} live prompt`,
    updatedAt: 5,
    stateStartedAt: 5,
    stateHistory: [],
    terminalTitle: `Title ${tabId}`,
    providerSession: { key: 'session_id', id: providerId, transcriptPath: `/u/${SENTINEL}.jsonl` }
  } as AgentStatusEntry
  if (ptyId) {
    tab.ptyId = ptyId
    bindPty(state, tabId, ptyId)
  }
  return tab
}

/** A record whose tab is closed: the sidebar lists it from the record alone. */
function closedTabRecord(state: TestState, tabId: string, providerId: string) {
  const tab = addSessionTestTab(state, tabId)
  const record = addSessionTestRecord(state, tab, providerId)
  state.tabsByWorktree[WT] = state.tabsByWorktree[WT]!.filter((row) => row.id !== tabId)
  delete state.terminalLayoutsByTabId[tabId]
  return record
}

function build(
  state: TestState,
  options: {
    live?: string[] | null
    view?: Partial<SessionSidebarView>
    archived?: string[]
    metadata?: SessionFolderMetadata
  } = {}
): SessionConversationLedgerWindowPublication {
  const view = { ...emptySessionSidebarView(), ...options.view }
  return buildSessionConversationLedger(asApp(state), {
    view: { view, archived: options.archived ?? view.archived ?? [] },
    metadata: options.metadata ?? noFolders(),
    livePtyIds: options.live === null ? null : new Set(options.live ?? []),
    chains: [],
    rendererGeneration: 'renderer:test',
    listedAt: 1
  })
}

function recordFor(
  publication: SessionConversationLedgerWindowPublication,
  tabId: string
): RuntimeSessionConversationRecord {
  const record = publication.recordsByWorktree[WT]?.find((entry) => entry.paneKey === pane(tabId))
  expect(record, `a record for ${tabId}`).toBeDefined()
  return record!
}

const viewKeyOf = (state: TestState, tabId: string): string =>
  conversationViewKey(buildSidebarSessions(state).find((row) => row.paneKey === pane(tabId))!)
const rowKeyOf = (state: TestState, tabId: string): string =>
  buildSidebarSessions(state).find((row) => row.paneKey === pane(tabId))!.rowKey

describe('buildSessionConversationLedger (session parity, step 2)', () => {
  it('lists live, dormant, asleep and tab-less record conversations with their identity', () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live', 'pty-live')
    addSessionTestTab(state, 'tab-dormant').launchAgent = 'claude'
    addSessionTestRecord(state, addSessionTestTab(state, 'tab-asleep'), 'p-asleep')
    closedTabRecord(state, 'tab-closed', 'p-closed')

    const publication = build(state, { live: ['pty-live'] })

    expect(recordFor(publication, 'tab-live')).toMatchObject({
      conversation: sessionConversationIdentity({
        worktreeId: WT,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'p-live' }
      }),
      paneIdentity: `pane:${pane('tab-live')}`,
      providerSession: { key: 'session_id', id: 'p-live' },
      surface: 'tab',
      tabId: 'tab-live',
      rest: 'live',
      title: 'Title tab-live',
      titleSource: 'terminal',
      listed: true
    })
    // A provider-less tab folds by its pane.
    expect(recordFor(publication, 'tab-dormant')).toMatchObject({
      conversation: null,
      paneIdentity: `pane:${pane('tab-dormant')}`,
      providerSession: null,
      surface: 'tab',
      rest: 'dormant'
    })
    expect(recordFor(publication, 'tab-asleep')).toMatchObject({
      providerSession: { key: 'session_id', id: 'p-asleep' },
      surface: 'tab',
      rest: 'asleep'
    })
    const closed = recordFor(publication, 'tab-closed')
    expect(closed).toMatchObject({ surface: 'record', rest: 'asleep', listed: true })
    expect(closed).not.toHaveProperty('tabId')
    expect(publication.coverage).toEqual([{ worktreeId: WT, complete: true }])
    expect(publication.omitted).toEqual({ unknownHost: 0, unverified: 0 })
    expect(readSessionConversationLedgerPublication(publication)?.coverage).toEqual([
      { worktreeId: WT, complete: true }
    ])
  })

  // F16: reconnect advertises the saved leaf PTY before any daemon answers.
  it('calls a restored pane whose mapped PTY is not alive dormant, never live', () => {
    const state = emptyState()
    const tab = addSessionTestTab(state, 'tab-restored')
    tab.launchAgent = 'claude'
    tab.ptyId = 'pty-dead'
    bindPty(state, 'tab-restored', 'pty-dead')
    // The window's own maps still pair the pane with that PTY.
    expect(livePtyIdForSessionPane(asApp(state), 'tab-restored', LEAF)).toBe('pty-dead')

    expect(recordFor(build(state, { live: ['pty-other'] }), 'tab-restored').rest).toBe('dormant')
    expect(recordFor(build(state, { live: ['pty-dead'] }), 'tab-restored').rest).toBe('live')
    expect(recordFor(build(state, { live: null }), 'tab-restored').rest).toBe('unknown')
    addSessionTestRecord(state, tab, 'p-restored')
    expect(recordFor(build(state, { live: [] }), 'tab-restored').rest).toBe('asleep')
  })

  it("carries the owner's archive marks tri-state and its folder, null when unfiled", () => {
    const state = emptyState()
    agentTab(state, 'tab-filed', 'p-filed')
    addSessionTestRecord(state, addSessionTestTab(state, 'tab-manual'), 'p-manual')
    addSessionTestRecord(state, addSessionTestTab(state, 'tab-auto'), 'p-auto')
    const manualKey = viewKeyOf(state, 'tab-manual')
    const autoKey = viewKeyOf(state, 'tab-auto')

    const publication = build(state, {
      archived: [manualKey, autoKey],
      view: {
        archived: [manualKey, autoKey],
        autoArchiveLog: [{ key: autoKey, proof: 'done', at: 1 }]
      },
      metadata: {
        version: 1,
        folders: [{ id: FOLDER, name: 'Launch' }],
        membership: { [viewKeyOf(state, 'tab-filed')]: FOLDER }
      }
    })

    const filed = recordFor(publication, 'tab-filed')
    expect(filed.archived).toEqual({ archived: false })
    expect(filed).toMatchObject({ folderId: FOLDER, saved: false, hidden: false })
    expect(recordFor(publication, 'tab-manual').archived).toEqual({ archived: true, byHand: true })
    expect(recordFor(publication, 'tab-auto').archived).toEqual({ archived: true, byHand: false })
    expect(recordFor(publication, 'tab-manual')).toHaveProperty('folderId', null)
    expect(publication.folders).toEqual([{ id: FOLDER, name: 'Launch' }])
    expect(publication.projects).toEqual([{ folderId: FOLDER }])
    // Main's reader keeps the explicit answers: unfiled is not unknown.
    const read = readSessionConversationLedgerPublication(JSON.parse(JSON.stringify(publication)))
    const manual = read?.recordsByWorktree[WT]?.find(
      (entry) => entry.paneKey === pane('tab-manual')
    )
    expect(manual).toMatchObject({ folderId: null, archived: { archived: true, byHand: true } })
  })

  // F2: no "(untitled)" text crosses; a receiver renders `titleSource: 'agent'` in its own language.
  it('publishes a prompt-only record as its agent’s name with titleSource agent, never its prompt', () => {
    const state = emptyState()
    const record = closedTabRecord(state, 'tab-prompt', 'p-prompt')
    Object.assign(record, { agent: 'claude', prompt: `${SENTINEL} fix the login` })
    delete record.terminalTitle
    // This computer's own sidebar still names the row by its prompt.
    expect(buildSidebarSessions(state)[0]).toMatchObject({
      label: `${SENTINEL} fix the login`,
      labelSource: 'agent'
    })

    const publication = build(state)
    expect(recordFor(publication, 'tab-prompt')).toMatchObject({
      title: 'claude',
      titleSource: 'agent',
      surface: 'record'
    })
    expect(JSON.stringify(publication)).not.toContain('(untitled)')
  })

  // F2 pinned: generated titles cross exactly as #1081's sessionTitle carries them; only the
  // prompt-only fallback becomes the agent's name. Flip both lines if Sal picks the stricter rule.
  it('sends a generated title — the owner’s preview of the first prompt — as generated, as #1081 does', () => {
    const state = emptyState()
    const tab = agentTab(state, 'tab-generated', 'p-generated')
    tab.generatedTitle =
      deriveGeneratedTabTitle(`Fix the login bug for the SSO rollout. ${SENTINEL} details`) ??
      undefined
    const record = closedTabRecord(state, 'tab-prompt', 'p-prompt')
    Object.assign(record, { agent: 'claude', prompt: `${SENTINEL} fix the login` })
    delete record.terminalTitle

    const publication = build(state)

    expect(tab.generatedTitle).toBeTruthy()
    expect(recordFor(publication, 'tab-generated')).toMatchObject({
      title: sessionOwnerTitle(tab, undefined),
      titleSource: 'generated'
    })
    expect(recordFor(publication, 'tab-prompt')).toMatchObject({
      title: 'claude',
      titleSource: 'agent'
    })
    expect(JSON.stringify(publication)).not.toContain(SENTINEL)
  })

  // F3: a null unverified reason is no ownership evidence; the classifier must say owned.
  it("quarantines a tab carrying a paired computer's PTY inside an owned workspace", () => {
    const state = emptyState()
    agentTab(state, 'tab-own', 'p-own', 'pty-own')
    const peer = addSessionTestTab(state, 'tab-peer')
    const remote = toRemoteRuntimePtyId('handle-1', 'studio')
    peer.launchAgent = 'claude'
    peer.ptyId = remote
    bindPty(state, 'tab-peer', remote)
    // The sidebar here lists it under this computer.
    expect(buildSidebarSessions(state).find((row) => row.tabId === 'tab-peer')?.hostId).toBe(
      'local'
    )

    const publication = build(state, { live: ['pty-own', remote] })

    expect(publication.recordsByWorktree[WT]!.map((entry) => entry.tabId)).toEqual(['tab-own'])
    expect(publication.omitted).toEqual({ unknownHost: 0, unverified: 1 })
    expect(publication.coverage).toEqual([{ worktreeId: WT, complete: false }])
    // F7: the owner's own counts read the same rule.
    const eligibility = selectConversationLedgerEligibility(
      asApp(state),
      emptySessionSidebarView(),
      []
    )
    expect([...eligibility.published]).toEqual([rowKeyOf(state, 'tab-own')])
    expect([...eligibility.quarantined]).toEqual([[rowKeyOf(state, 'tab-peer'), 'peer-provenance']])
  })

  // F3/F7: one rule for both publishers (main-conversation-ledger.test.ts pins main's side).
  it('quarantines every row of an unresolved workspace, even a tab a local PTY made owned', () => {
    const state = emptyState()
    agentTab(state, 'tab-own', 'p-own', 'pty-old')
    // A paired computer's record of the same worktree: the saved catalog names two owners.
    Object.assign(state, {
      detectedWorktreesByRepo: {
        'repo-a': {
          worktrees: [{ id: WT, repoId: 'repo-a', runtimeOwnerEnvironmentId: 'env-studio' }]
        }
      }
    })

    const publication = build(state, { live: ['pty-old'] })

    expect(publication.recordsByWorktree).toEqual({})
    expect(publication.omitted).toEqual({ unknownHost: 0, unverified: 1 })
    expect(publication.coverage).toEqual([{ worktreeId: WT, complete: false }])
    const eligibility = selectConversationLedgerEligibility(
      asApp(state),
      emptySessionSidebarView(),
      []
    )
    // The visible sidebar's slices list it under this computer; only the catalog is in doubt.
    expect([...eligibility.quarantined]).toEqual([
      [JSON.stringify(['local', WT, pane('tab-own')]), 'unresolved-workspace']
    ])
  })

  it('leaves a direct-SSH record out, uncounted, and its workspace incomplete', () => {
    const state = emptyState()
    agentTab(state, 'tab-own', 'p-own')
    closedTabRecord(state, 'tab-ssh', 'p-ssh').connectionId = 'conn-1'

    const publication = build(state)

    expect(publication.recordsByWorktree[WT]!.map((record) => record.tabId)).toEqual(['tab-own'])
    expect(publication.omitted).toEqual({ unknownHost: 0, unverified: 0 })
    expect(publication.coverage).toEqual([{ worktreeId: WT, complete: false }])
  })

  it('leaves out a workspace whose id is too long to cross, counting its rows', () => {
    const state = emptyState()
    agentTab(state, 'tab-own', 'p-own')
    const deep = `repo-a::/${'deep/'.repeat(200)}`
    const deepWorktree = { id: deep, repoId: 'repo-a', displayName: 'deep', hostId: 'local' }
    state.worktreesByRepo['repo-a'] = [
      ...state.worktreesByRepo['repo-a']!,
      deepWorktree as (typeof state.worktreesByRepo)[string][number]
    ]
    addSessionTestTab(state, 'tab-deep', deep).launchAgent = 'claude'

    const publication = build(state)

    expect(Object.keys(publication.recordsByWorktree)).toEqual([WT])
    expect(publication.omitted).toEqual({ unknownHost: 0, unverified: 1 })
    expect(publication.coverage).toEqual([{ worktreeId: WT, complete: true }])
    // Main reads it back with the count as sent: nothing dropped twice, nothing silently.
    expect(readSessionConversationLedgerPublication(publication)?.omitted).toEqual({
      unknownHost: 0,
      unverified: 1
    })
  })

  it('counts a row under no execution host and leaves its workspace incomplete', () => {
    const state = emptyState()
    agentTab(state, 'tab-own', 'p-own')
    const stray = closedTabRecord(state, 'tab-stray', 'p-stray')
    delete state.sleepingAgentSessionsByPaneKey[stray.paneKey]
    state.sleepingAgentSessionsByPaneKey[stray.paneKey] = { ...stray, worktreeId: 'gone::/old' }

    const publication = build(state)

    expect(publication.omitted).toEqual({ unknownHost: 1, unverified: 0 })
    expect(publication.coverage).toEqual([
      { worktreeId: 'gone::/old', complete: false },
      { worktreeId: WT, complete: true }
    ])
  })

  // G1: a receiver's capture of it folds onto it instead of being retired.
  it('lists passive completed hibernation evidence apart, with listed:false', () => {
    const state = emptyState()
    const record = closedTabRecord(state, 'tab-passive', 'p-passive')
    Object.assign(record, { state: 'done', origin: 'worktree-sleep' })
    expect(buildSidebarSessions(state)).toEqual([])

    const publication = build(state)

    expect(publication.recordsByWorktree[WT]).toEqual([
      expect.objectContaining({
        conversation: sessionConversationIdentity(record),
        paneKey: pane('tab-passive'),
        surface: 'record',
        rest: 'asleep',
        listed: false
      })
    ])
    expect(publication.coverage).toEqual([{ worktreeId: WT, complete: true }])
    expect(
      selectConversationLedgerEligibility(asApp(state), emptySessionSidebarView(), [])
    ).toEqual({ published: new Set(), quarantined: new Map() })
  })

  // Integration: main tombstones every durable delete mark (step 3), so a deleted conversation whose
  // tab is open again is listed here and tombstoned there; the store holds that tombstone back by
  // the identities this record carries, which must be the ones the tombstone names.
  it('lists a deleted conversation whose tab is open again under the identities its tombstone names', () => {
    const state = emptyState()
    agentTab(state, 'tab-reopened', 'p-reopened')
    addSessionTestTab(state, 'tab-pane').launchAgent = 'claude'
    closedTabRecord(state, 'tab-gone', 'p-gone')
    const deleted = ['tab-reopened', 'tab-pane', 'tab-gone'].map((tabId) => viewKeyOf(state, tabId))

    const publication = build(state, { view: { deleted } })

    // The sidebar's rule: only the tab-less row leaves the list.
    expect(publication.recordsByWorktree[WT]!.map((record) => record.paneKey).sort()).toEqual(
      [pane('tab-pane'), pane('tab-reopened')].sort()
    )
    // As conversation-ledger-removals.ts maps a local delete mark: a provider key to its digest,
    // a pane key to its pane identity.
    const tombstones = deleted.map((key): RuntimeSessionConversationRemoval => {
      const [, kind, worktreeId, paneKey] = JSON.parse(key) as string[]
      return kind === 'provider'
        ? { ...sessionConversationIdentityFromProviderKey(key)!, at: 1 }
        : {
            worktreeId: worktreeId!,
            paneIdentity: sessionConversationPaneIdentity(paneKey!),
            at: 1
          }
    })
    const held = sessionConversationListedRemovalKeys(publication.recordsByWorktree)
    expect(tombstones.map((removal) => held.has(sessionConversationRemovalKey(removal)))).toEqual([
      true,
      true,
      false
    ])
  })

  it('reads every workspace incomplete until this window restored its sessions', () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live')
    state.hydrationSucceeded = false
    expect(build(state).coverage).toEqual([{ worktreeId: WT, complete: false }])
    state.hydrationSucceeded = true
    state.terminalStartupRestorationReady = false
    expect(build(state).coverage).toEqual([{ worktreeId: WT, complete: false }])
  })

  it('never serializes a prompt, transcript path, launch config, reply or project setting', () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live', 'pty-live')
    const record = closedTabRecord(state, 'tab-pi', 'p-pi')
    Object.assign(record, {
      agent: 'pi',
      prompt: `${SENTINEL} prompt`,
      lastAssistantMessage: `${SENTINEL} reply`,
      launchConfig: { agentArgs: `--flag ${SENTINEL}`, agentEnv: { TOKEN: SENTINEL } },
      providerSession: { key: 'session_id', id: 'p-pi', transcriptPath: `/u/${SENTINEL}.jsonl` }
    })
    delete record.terminalTitle
    const metadata: SessionFolderMetadata = {
      version: 1,
      folders: [{ id: FOLDER, name: 'Launch' }],
      membership: {},
      projects: {
        [FOLDER]: {
          ...emptyProjectSettings(1),
          agents: [{ templateId: 't', name: 'R', digest: 'abcdefabcdef', instructions: SENTINEL }],
          attachments: [{ id: 'a', kind: 'instructions', title: 'Notes', content: SENTINEL }]
        }
      }
    }

    const publication = build(state, { live: ['pty-live'], metadata })
    const serialized = JSON.stringify(publication)

    expect(serialized).not.toContain(SENTINEL)
    // Pi's digest still covers the transcript path the wire never carries.
    expect(recordFor(publication, 'tab-pi')).toMatchObject({
      conversation: sessionConversationIdentity(record),
      title: 'pi',
      titleSource: 'agent'
    })
  })
})

function fakePty(initial: string[]) {
  const exits = new Set<(data: { id: string; code: number }) => void>()
  const api: LivePtyCensusApi = {
    listSessions: vi.fn(async () =>
      initial.map((id) => ({ id, cwd: '/', title: '', agentOwnership: 'unknown' as const }))
    ),
    onSpawned: () => () => {},
    onExit: (callback) => {
      exits.add(callback)
      return () => {
        exits.delete(callback)
      }
    }
  }
  return { api, exit: (id: string) => exits.forEach((callback) => callback({ id, code: 0 })) }
}

function useStores(state: TestState, view: Partial<SessionSidebarView> = {}): void {
  useAppStore.setState({ ...state })
  const merged = { ...emptySessionSidebarView(), ...view }
  useSessionSidebarView.setState({
    loaded: true,
    archiveStorageReady: true,
    view: merged,
    archived: merged.archived ?? []
  })
  useSessionFolders.setState({ loaded: true, metadata: noFolders() })
}

const lastSent = (send: ReturnType<typeof vi.fn>): SessionConversationLedgerWindowPublication =>
  send.mock.lastCall![0] as SessionConversationLedgerWindowPublication

const running: (() => void)[] = []

/** Starts a publisher that is stopped after the test even when an assertion fails first. */
function start(...args: Parameters<typeof startSessionConversationLedgerPublication>): () => void {
  const stop = startSessionConversationLedgerPublication(...args)
  running.push(stop)
  return stop
}

describe('startSessionConversationLedgerPublication', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    running.splice(0).forEach((stop) => stop())
    vi.useRealTimers()
  })

  // B1: the visible sidebar's deletion marks apply; the resumable record stays on the owner.
  it('omits a deleted archived record-only conversation, and its undo restores it', async () => {
    const state = emptyState()
    closedTabRecord(state, 'tab-gone', 'p-gone')
    const key = viewKeyOf(state, 'tab-gone')
    useStores(state, { archived: [key], deleted: [key] })
    const send = vi.fn().mockResolvedValue(undefined)
    const stop = start(send, { pty: fakePty([]).api })
    await vi.advanceTimersByTimeAsync(0)

    expect(send).toHaveBeenCalledTimes(1)
    expect(lastSent(send).recordsByWorktree).toEqual({})
    // A deletion is no omission: the workspace is still complete.
    expect(lastSent(send).coverage).toEqual([{ worktreeId: WT, complete: true }])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[pane('tab-gone')]).toBeDefined()

    useSessionSidebarView.setState({
      view: { ...useSessionSidebarView.getState().view, deleted: [] }
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(send).toHaveBeenCalledTimes(2)
    expect(lastSent(send).recordsByWorktree[WT]).toEqual([
      expect.objectContaining({
        paneKey: pane('tab-gone'),
        archived: { archived: true, byHand: true }
      })
    ])
    stop()
  })

  it('publishes nothing for an unrelated change, and once per real change', async () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live')
    useStores(state)
    const send = vi.fn().mockResolvedValue(undefined)
    const stop = start(send, { pty: fakePty([]).api })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)

    useAppStore.setState({ activeTabId: 'elsewhere' })
    useSessionSidebarView.setState({
      view: { ...useSessionSidebarView.getState().view, collapsed: ['group'] }
    })
    // A status ping that moves no row.
    const entry = useAppStore.getState().agentStatusByPaneKey[pane('tab-live')]!
    useAppStore.setState({
      agentStatusByPaneKey: { [pane('tab-live')]: { ...entry, updatedAt: 99, toolName: 'Edit' } }
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(send).toHaveBeenCalledTimes(1)

    const tab = useAppStore.getState().tabsByWorktree[WT]![0]!
    useAppStore.setState({ tabsByWorktree: { [WT]: [{ ...tab, customTitle: 'Renamed' }] } })
    useAppStore.setState({ tabsByWorktree: { [WT]: [{ ...tab, customTitle: 'Renamed' }] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(send).toHaveBeenCalledTimes(2)
    expect(recordFor(lastSent(send), 'tab-live')).toMatchObject({
      title: 'Renamed',
      titleSource: 'custom'
    })
    stop()
    useAppStore.setState({ tabsByWorktree: {} })
    await vi.advanceTimersByTimeAsync(200)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("waits for the person's marks to load and never loads them itself", async () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live')
    useStores(state)
    const load = vi.fn()
    useSessionFolders.setState({ loaded: false, load })
    const send = vi.fn().mockResolvedValue(undefined)
    const stop = start(send, { pty: fakePty([]).api })
    await vi.advanceTimersByTimeAsync(500)
    expect(send).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()

    useSessionFolders.setState({ loaded: true })
    await vi.advanceTimersByTimeAsync(200)
    expect(send).toHaveBeenCalledTimes(1)
    stop()
  })

  it("follows main's PTY census: unknown until it answers, dormant once the PTY exits", async () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live', 'pty-live')
    useStores(state)
    const pty = fakePty(['pty-live'])
    const send = vi.fn().mockResolvedValue(undefined)
    const stop = start(send, { pty: pty.api })
    await vi.advanceTimersByTimeAsync(200)

    expect(send.mock.calls.map(([sent]) => recordFor(sent, 'tab-live').rest)).toEqual([
      'unknown',
      'live'
    ])
    pty.exit('pty-live')
    await vi.advanceTimersByTimeAsync(200)
    expect(recordFor(lastSent(send), 'tab-live').rest).toBe('dormant')
    stop()
  })

  it('retries a publication main refused once this renderer’s graph lands', async () => {
    const state = emptyState()
    agentTab(state, 'tab-live', 'p-live')
    useStores(state)
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('session_conversation_ledger_publisher_not_current'))
      .mockResolvedValue(undefined)
    const stop = start(send)
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)

    for (const listener of graph.listeners) {
      listener()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(lastSent(send).rendererGeneration).toBe('renderer:test')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(send).toHaveBeenCalledTimes(2)
    stop()
    expect(graph.listeners.size).toBe(0)
  })
})
