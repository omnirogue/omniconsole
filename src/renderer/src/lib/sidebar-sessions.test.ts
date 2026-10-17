import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { Tab } from '../../../shared/tab-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { buildPaneSessions, buildSidebarSessions } from './sidebar-sessions'
import { providerSessionFolderKey } from './session-folder-identity'
import {
  emptySessionFolderMetadata,
  getSessionFolderId,
  moveSessionToFolder
} from './session-folders'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE
} from './sidebar-session-test-fixtures'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { SidebarSessionSource } from './sidebar-sessions'
import { mirroredConversationRowKey } from './mirrored-conversation-rows'
import {
  addMirrorTab,
  LEDGER_ENV,
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  pairedSource,
  providerSession
} from './mirrored-conversation-test-fixtures'

describe('normal sidebar session projection', () => {
  it('retains both exact pane owners when the sidebar folds a resumed provider conversation', () => {
    const source = sessionTestSource()
    const original = addSessionTestRecord(source, addSessionTestTab(source, 'original-tab'))
    const resumed = addSessionTestRecord(source, addSessionTestTab(source, 'resumed-tab'))
    const before = JSON.stringify(source)
    expect(buildSidebarSessions(source)).toHaveLength(1)
    const rows = buildPaneSessions(source)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.paneKey)).toEqual([original.paneKey, resumed.paneKey])
    expect(rows[0].sessionKey).toBe(rows[1].sessionKey)
    expect(rows[0].rowKey).not.toBe(rows[1].rowKey)
    expect(JSON.stringify(source)).toBe(before)
  })

  it.each(['working', 'waiting', 'done'] as const)(
    'projects the newest resumed pane when it reports %s, regardless of tab order',
    (state) => {
      const source = sessionTestSource()
      const original = addSessionTestRecord(source, addSessionTestTab(source, 'original-tab'))
      const resumed = addSessionTestRecord(source, addSessionTestTab(source, 'resumed-tab'))
      for (const [record, status, observedAt] of [
        [original, 'done', 100],
        [resumed, state, 200]
      ] as const) {
        source.agentStatusByPaneKey[record.paneKey] = {
          ...record,
          agentType: 'codex',
          state: status,
          stateStartedAt: observedAt,
          updatedAt: 300,
          evidenceObservedAt: observedAt,
          stateHistory: []
        }
      }
      const expected = {
        paneKey: resumed.paneKey,
        tabId: resumed.tabId,
        label: resumed.terminalTitle
      }
      expect(buildSidebarSessions(source)).toEqual([expect.objectContaining(expected)])
      source.tabsByWorktree[SESSION_TEST_WORKTREE].reverse()
      expect(buildSidebarSessions(source)).toEqual([expect.objectContaining(expected)])
      expect(buildPaneSessions(source)).toHaveLength(2)
    }
  )

  it('prefers an observed resumed pane over the older saved record without changing identity', () => {
    const source = sessionTestSource()
    addSessionTestRecord(source, addSessionTestTab(source, 'original-tab'))
    const before = buildSidebarSessions(source)[0].sessionKey
    const resumed = addSessionTestRecord(source, addSessionTestTab(source, 'resumed-tab'))
    source.agentStatusByPaneKey[resumed.paneKey] = {
      ...resumed,
      agentType: 'codex',
      state: 'working',
      stateStartedAt: 200,
      stateHistory: []
    }
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      sessionKey: before,
      paneKey: resumed.paneKey
    })
  })

  it('gives a fresh terminal pane a provisional, filable key before any provider identity arrives', () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source)
    const before = JSON.stringify(source)
    const rows = buildSidebarSessions(source)
    // Why: draggability (SessionSidebarRow) only needs sessionKey to be non-null.
    expect(rows).toEqual([
      expect.objectContaining({ tabId: tab.id, sessionKey: expect.any(String), agent: 'codex' })
    ])
    expect(JSON.stringify(source)).toBe(before)
    const provisionalKey = rows[0].sessionKey
    addSessionTestRecord(source, tab)
    const afterRecord = buildSidebarSessions(source)[0]
    // Why: once a provider session is known it takes over as the primary key, and
    // the row carries a migration instruction so the provisional folder entry
    // (if any) follows it — see session-folder-key-migration.ts.
    expect(afterRecord.sessionKey).not.toBeNull()
    expect(afterRecord.sessionKey).not.toBe(provisionalKey)
    expect(afterRecord.folderKeyMigration).toEqual({
      from: provisionalKey,
      to: afterRecord.sessionKey
    })
  })

  it('keeps membership on resume in a new tab and isolates a replacement session in the old pane', () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source)
    const original = addSessionTestRecord(source, tab)
    const originalKey = buildSidebarSessions(source)[0].sessionKey!
    const metadata = moveSessionToFolder(
      {
        ...emptySessionFolderMetadata(),
        folders: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Planning' }]
      },
      originalKey,
      '00000000-0000-4000-8000-000000000001'
    )
    source.agentStatusByPaneKey[original.paneKey] = {
      ...original,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'replacement' },
      stateStartedAt: 200,
      stateHistory: []
    } as AgentStatusEntry
    const replacement = buildSidebarSessions(source)[0]
    expect(replacement.sessionKey).not.toBe(originalKey)
    expect(getSessionFolderId(metadata, replacement.sessionKey)).toBeNull()
    const resumed = addSessionTestTab(source, 'resumed-tab')
    addSessionTestRecord(source, resumed, original.providerSession.id)
    expect(
      getSessionFolderId(
        metadata,
        buildSidebarSessions(source).find((row) => row.tabId === resumed.id)!.sessionKey
      )
    ).not.toBeNull()
  })

  it('includes arbitrary folder workspaces and ordinary Build + Review workers without touching their placement', () => {
    const source = sessionTestSource()
    const folderId = 'notes-folder'
    const workspaceId = folderWorkspaceKey(folderId)
    source.folderWorkspaces = [
      {
        id: folderId,
        name: 'Notes',
        folderPath: '/arbitrary/notes',
        executionHostId: 'local'
      } as FolderWorkspace
    ]
    const folderTab = addSessionTestTab(source, 'folder-tab', workspaceId)
    addSessionTestRecord(source, folderTab)
    const worker = addSessionTestTab(source, 'review-tab')
    const record = addSessionTestRecord(source, worker, 'review-session')
    source.agentStatusByPaneKey[record.paneKey] = {
      ...record,
      agentType: 'codex',
      stateStartedAt: 100,
      stateHistory: [],
      orchestration: { taskId: 'existing-task', dispatchId: 'existing-dispatch' }
    } as AgentStatusEntry
    expect(buildSidebarSessions(source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId: workspaceId,
          workspaceLabel: 'Notes',
          sessionKey: expect.any(String)
        }),
        expect.objectContaining({
          worktreeId: SESSION_TEST_WORKTREE,
          tabId: worker.id,
          sessionKey: expect.any(String)
        })
      ])
    )
    expect(folderTab.worktreeId).toBe(workspaceId)
    expect(worker.worktreeId).toBe(SESSION_TEST_WORKTREE)
  })

  it('does not file a fresh replacement from an older resume record in the same pane', () => {
    const source = sessionTestSource()
    const record = addSessionTestRecord(source, addSessionTestTab(source))
    const originalKey = buildSidebarSessions(source)[0].sessionKey!
    source.agentStatusByPaneKey[record.paneKey] = {
      paneKey: record.paneKey,
      tabId: record.tabId,
      worktreeId: record.worktreeId,
      agentType: 'codex',
      state: 'working',
      prompt: '',
      updatedAt: 200,
      stateStartedAt: 200,
      stateHistory: []
    }
    const replacement = buildSidebarSessions(source)[0]
    // Why: this new live entry has no provider identity of its own, so it must
    // fall back to the pane's own provisional key rather than reuse the older
    // record's provider key — otherwise it would silently inherit that old
    // conversation's folder.
    expect(replacement.sessionKey).not.toBeNull()
    expect(replacement.sessionKey).not.toBe(originalKey)
    const metadata = moveSessionToFolder(
      {
        ...emptySessionFolderMetadata(),
        folders: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Old' }]
      },
      originalKey,
      '00000000-0000-4000-8000-000000000002'
    )
    expect(getSessionFolderId(metadata, replacement.sessionKey)).toBeNull()
  })

  it('keeps each split pane associated with its own provider session', () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source)
    const first = addSessionTestRecord(source, tab)
    const secondLeaf = '00000000-0000-4000-8000-000000000002'
    const secondPaneKey = `${tab.id}:${secondLeaf}`
    source.terminalLayoutsByTabId[tab.id].root = {
      type: 'split',
      direction: 'horizontal',
      first: source.terminalLayoutsByTabId[tab.id].root!,
      second: { type: 'leaf', leafId: secondLeaf }
    }
    source.sleepingAgentSessionsByPaneKey[secondPaneKey] = {
      ...first,
      paneKey: secondPaneKey,
      providerSession: { key: 'session_id', id: 'split-session' }
    }
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(2)
    expect(rows[0].paneKey).not.toBe(rows[1].paneKey)
    expect(rows[0].sessionKey).not.toBe(rows[1].sessionKey)
  })

  it('gives each pane of a multi-pane tab its own filable key before any provider session is known', () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source)
    const secondLeaf = '00000000-0000-4000-8000-000000000003'
    const secondPaneKey = `${tab.id}:${secondLeaf}`
    source.terminalLayoutsByTabId[tab.id].root = {
      type: 'split',
      direction: 'horizontal',
      first: source.terminalLayoutsByTabId[tab.id].root!,
      second: { type: 'leaf', leafId: secondLeaf }
    }
    const firstPaneKey = `${tab.id}:${SESSION_TEST_LEAF}`
    // Why: an explicit per-pane agent (not tab.launchAgent) sidesteps the
    // ambiguity that keeps keys.size === 1 gating tab-level provider-session
    // inference — a real terminal reports agentType per pane once it starts.
    source.agentStatusByPaneKey[firstPaneKey] = {
      paneKey: firstPaneKey,
      tabId: tab.id,
      worktreeId: tab.worktreeId,
      agentType: 'claude',
      state: 'working',
      prompt: '',
      updatedAt: 100,
      stateStartedAt: 100,
      stateHistory: []
    }
    source.agentStatusByPaneKey[secondPaneKey] = {
      paneKey: secondPaneKey,
      tabId: tab.id,
      worktreeId: tab.worktreeId,
      agentType: 'codex',
      state: 'working',
      prompt: '',
      updatedAt: 100,
      stateStartedAt: 100,
      stateHistory: []
    }
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.sessionKey).not.toBeNull()
    }
    expect(rows[0].sessionKey).not.toBe(rows[1].sessionKey)
  })

  it('never gives two different conversations the same key', () => {
    const source = sessionTestSource()
    const provisionalOnly = addSessionTestTab(source, 'tab-provisional')
    source.worktreesByRepo['repo-a'] = [
      ...source.worktreesByRepo['repo-a'],
      { id: 'repo-a::/project-b', repoId: 'repo-a', displayName: 'other', hostId: 'local' } as never
    ]
    addSessionTestTab(source, 'tab-provisional-2', 'repo-a::/project-b')
    const withProvider = addSessionTestTab(source, 'tab-provider')
    addSessionTestRecord(source, withProvider, 'unique-provider-a')
    const structuredTab = {
      id: 'structured-tab-unique',
      entityId: 'unique-provider-a',
      worktreeId: SESSION_TEST_WORKTREE,
      executionHostId: 'local',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Structured'
    } as Tab
    source.unifiedTabsByWorktree[SESSION_TEST_WORKTREE] = [structuredTab]
    const rows = buildSidebarSessions(source)
    const keys = rows.map((row) => row.sessionKey).filter((key): key is string => key !== null)
    expect(new Set(keys).size).toBe(keys.length)
    expect(provisionalOnly).toBeTruthy()
  })

  it('keeps a provisional pane key stable across a simulated app restart', () => {
    const source = sessionTestSource()
    addSessionTestTab(source)
    const before = buildSidebarSessions(source)[0].sessionKey
    // Why: a restart rehydrates tabsByWorktree/terminalLayoutsByTabId from disk;
    // this deep clone stands in for that round trip without minting new ids,
    // matching how normalizeTerminalLayoutLeafIds only re-mints on collision.
    const restored = {
      ...source,
      tabsByWorktree: JSON.parse(JSON.stringify(source.tabsByWorktree)),
      terminalLayoutsByTabId: JSON.parse(JSON.stringify(source.terminalLayoutsByTabId))
    }
    expect(buildSidebarSessions(restored)[0].sessionKey).toBe(before)
    expect(before).not.toBeNull()
  })

  it('separates provider families, hosts, workspace identities and Pi session locators', () => {
    const identity = {
      hostId: 'local' as const,
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'codex',
      providerSession: { key: 'session_id' as const, id: 'same-provider-id' }
    }
    const keys = [
      providerSessionFolderKey(identity),
      providerSessionFolderKey({ ...identity, agent: 'claude' }),
      providerSessionFolderKey({ ...identity, hostId: 'ssh:server' }),
      providerSessionFolderKey({ ...identity, worktreeId: 'folder:notes' }),
      providerSessionFolderKey({
        ...identity,
        agent: 'pi',
        providerSession: { ...identity.providerSession, transcriptPath: '/one/session.jsonl' }
      }),
      providerSessionFolderKey({
        ...identity,
        agent: 'pi',
        providerSession: { ...identity.providerSession, transcriptPath: '/two/session.jsonl' }
      })
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('files structured sessions immediately by durable entity identity and isolates paired hosts', () => {
    const source = sessionTestSource()
    const tab = {
      id: 'structured-tab',
      entityId: 'existing-agent-session',
      worktreeId: SESSION_TEST_WORKTREE,
      executionHostId: 'local',
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Structured session'
    } as Tab
    source.unifiedTabsByWorktree[SESSION_TEST_WORKTREE] = [
      tab,
      { ...tab, id: 'remote-tab', executionHostId: 'runtime:server' }
    ]
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sessionKey: expect.any(String),
      structuredSessionId: 'existing-agent-session',
      unavailable: false
    })
    expect(rows[1]).toMatchObject({
      sessionKey: expect.any(String),
      structuredSessionId: 'existing-agent-session',
      unavailable: true
    })
    expect(rows[0].sessionKey).not.toBe(rows[1].sessionKey)
  })

  it('retains disconnected SSH rows as unverifiable and ignores unresumable detached history', () => {
    const source = sessionTestSource()
    source.repos[0].executionHostId = 'ssh:offline-host'
    source.worktreesByRepo['repo-a'][0].hostId = 'ssh:offline-host'
    const tab = addSessionTestTab(source)
    const record = addSessionTestRecord(source, tab)
    source.tabsByWorktree = {}
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      tabId: null,
      hostId: 'ssh:offline-host',
      unavailable: true,
      sessionKey: expect.any(String)
    })
    record.origin = 'worktree-sleep'
    record.state = 'done'
    expect(buildSidebarSessions(source)).toEqual([])
  })

  it('retains a saved SSH identity while the matching remote workspace catalog is unavailable', () => {
    const source = sessionTestSource()
    const record = addSessionTestRecord(source, addSessionTestTab(source))
    record.connectionId = 'remote-host'
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      hostId: 'ssh:remote-host',
      unavailable: true,
      sessionKey: providerSessionFolderKey({ ...record, hostId: 'ssh:remote-host' })
    })
  })

  it("names an offline SSH project's computer while its workspace list is missing", () => {
    const source = sessionTestSource()
    source.repos = [{ ...source.repos[0], executionHostId: undefined, connectionId: 'mw0003' }]
    source.worktreesByRepo = {}
    addSessionTestTab(source)
    // Why: the Studio listed these leftover SSH sessions as "Unknown computer".
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      hostId: 'ssh:mw0003',
      unavailable: true
    })
  })

  it('keeps a removed local workspace unplaced rather than calling it this computer', () => {
    const source = sessionTestSource()
    source.worktreesByRepo = {}
    addSessionTestTab(source)
    expect(buildSidebarSessions(source)[0]).toMatchObject({ hostId: null, unavailable: true })
  })
})

describe('a filed tab whose agent failed to resume', () => {
  function unresumedTab(source: ReturnType<typeof sessionTestSource>) {
    const tab = addSessionTestTab(source)
    delete tab.launchAgent
    tab.customTitle = 'Advertising'
    tab.aiVaultTitle = { agent: 'codex', sessionId: 'sess-1', title: 'Review policy' } as never
    return tab
  }

  it('keeps its row from aiVaultTitle when it has a single layout pane', () => {
    const source = sessionTestSource()
    unresumedTab(source)
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe('codex')
    expect(rows[0].label).toBe('Advertising')
    expect(rows[0].providerSession?.id).toBe('sess-1')
    expect(rows[0].sessionKey).toBe(
      providerSessionFolderKey({
        hostId: rows[0].hostId!,
        worktreeId: SESSION_TEST_WORKTREE,
        agent: 'codex',
        providerSession: rows[0].providerSession!
      })
    )
  })

  it('infers nothing from aiVaultTitle on a multi-pane tab', () => {
    const source = sessionTestSource()
    const tab = unresumedTab(source)
    source.terminalLayoutsByTabId[tab.id].root = {
      type: 'split',
      direction: 'horizontal',
      first: source.terminalLayoutsByTabId[tab.id].root!,
      second: { type: 'leaf', leafId: '00000000-0000-4000-8000-000000000003' }
    }
    expect(buildSidebarSessions(source)).toHaveLength(0)
  })

  it('yields no row for a bare terminal with no agent and no aiVaultTitle', () => {
    const source = sessionTestSource()
    const tab = unresumedTab(source)
    tab.aiVaultTitle = null
    expect(buildSidebarSessions(source)).toHaveLength(0)
  })
})

describe('an unloaded or partial store', () => {
  it('returns no rows instead of throwing when pane-keyed slices are absent', () => {
    const partial = {
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      sshConnectionStates: new Map(),
      runtimeStatusByEnvironmentId: new Map()
      // unifiedTabsByWorktree, tabsByWorktree, terminalLayoutsByTabId,
      // agentStatusByPaneKey, sleepingAgentSessionsByPaneKey,
      // pendingStartupByTabId, automaticAgentResumeClaimsByTabId all absent —
      // a caller reading `useAppStore.getState()` under a partial test double,
      // or before the real store hydrates, hands us exactly this shape.
    } as unknown as Parameters<typeof buildSidebarSessions>[0]
    expect(() => buildSidebarSessions(partial)).not.toThrow()
    expect(buildSidebarSessions(partial)).toEqual([])
  })
})

describe('with a paired owner’s conversation ledger (session parity, step 6)', () => {
  const CAPTURE = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)
  type Arrival = (source: SidebarSessionSource) => void

  const frame: Arrival = (source) => {
    const tab = addMirrorTab(source)
    const paneKey = makePaneKey(tab.id, SESSION_TEST_LEAF)
    source.agentStatusByPaneKey[paneKey] = {
      paneKey,
      tabId: tab.id,
      worktreeId: SESSION_TEST_WORKTREE,
      state: 'working',
      agentType: 'claude',
      providerSession: providerSession('s1'),
      updatedAt: 10
    } as unknown as AgentStatusEntry
  }
  const capture: Arrival = (source) => {
    source.sleepingAgentSessionsByPaneKey[CAPTURE] = {
      paneKey: CAPTURE,
      tabId: CAPTURE.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'claude',
      providerSession: providerSession('s1'),
      prompt: 'Look at the ads',
      terminalTitle: 'Advertising check',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
  }
  const ledger =
    (record = ledgerRecord('s1', { paneKey: OWNER_PANE })): Arrival =>
    (source) => {
      Object.assign(source, ledgerSlices([ledgerBucket([record])]))
    }

  function permutations<T>(items: readonly T[]): T[][] {
    return items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest
          ])
        )
  }

  it('gives a mirror tab no row was built for one row, with the owner’s state', () => {
    const source = pairedSource()
    const tab = addMirrorTab(source, undefined, null)
    expect(buildSidebarSessions(source)).toEqual([])
    Object.assign(
      source,
      ledgerSlices(
        [
          ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE, rest: 'asleep' })], {
            ownerState: 'unreachable'
          })
        ],
        [ledgerOwner({ state: 'unreachable' })]
      )
    )
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tabId: tab.id,
      mirroredConversation: { rest: 'asleep', ownerState: 'unreachable' }
    })
  })

  it('keeps a live mirror and its ledger record as one row', () => {
    const source = pairedSource()
    frame(source)
    const before = buildSidebarSessions(source)
    ledger()(source)
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.rowKey).toBe(before[0]!.rowKey)
    expect(rows[0]!.mirroredConversation?.rest).toBe('live')
  })

  it('lists a capture, its live mirror and the ledger as one row in every arrival order', () => {
    const finals = permutations([frame, capture, ledger()]).map((order) => {
      const source = pairedSource()
      const counts = order.map((arrive) => {
        arrive(source)
        return buildSidebarSessions(source).length
      })
      // Why ≤ 1 throughout: one conversation never reads as two, whatever arrived first.
      expect(counts.every((count) => count <= 1)).toBe(true)
      return buildSidebarSessions(source)
    })
    for (const rows of finals) {
      expect(rows).toEqual(finals[0])
      expect(rows[0]?.mirroredConversation?.listed).toBe(true)
    }
  })

  it('folds a capture into a record-only ledger row in either order', () => {
    const record = ledgerRecord('s1')
    const finals = permutations([capture, ledger(record)]).map((order) => {
      const source = pairedSource()
      order.forEach((arrive) => arrive(source))
      return buildSidebarSessions(source)
    })
    for (const rows of finals) {
      expect(rows.map((row) => row.rowKey)).toEqual([
        mirroredConversationRowKey(LEDGER_ENV, SESSION_TEST_WORKTREE, record)
      ])
    }
  })

  it('makes no row of a listed:false record (G1)', () => {
    const source = pairedSource()
    ledger(ledgerRecord('s1', { listed: false }))(source)
    expect(buildSidebarSessions(source)).toEqual([])
    expect(buildPaneSessions(source)).toEqual([])
  })
})
