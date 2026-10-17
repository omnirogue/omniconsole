import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import type { AppState } from '@/store'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { emptySessionFolderMetadata, getSessionFolderId } from './session-folders'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions } from './sidebar-sessions'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { mirroredConversationRowKey } from './mirrored-conversation-rows'
import {
  addMirrorTab,
  conversationDigest,
  LEDGER_ENV,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  paneRecord,
  pairedSource
} from './mirrored-conversation-test-fixtures'

type Session = { key: 'session_id'; id: string }

/**
 * Astra F4 (C5): one conversation open in two tabs. A metadata-less `done → working` used to
 * drop its provider identity, so the rows split into two pane-keyed rows and left Archived, then
 * merged back when the metadata returned — counts moving with nothing created or deleted.
 */
function conversationInTabs(tabIds: readonly string[]) {
  const source = sessionTestSource()
  const tabs = tabIds.map((id) => addSessionTestTab(source, id))
  for (const tab of tabs) {
    addSessionTestRecord(source, tab, 'same')
  }
  const store = createTestStore()
  // Why the stub: a completed turn asks GitHub about the workspace, which this test has no window for.
  store.setState({ ...source, refreshGitHubForWorktreeIfStale: () => {} } as Partial<AppState>)
  const panes = tabs.map((tab, index) => ({
    paneKey: makePaneKey(tab.id, SESSION_TEST_LEAF),
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    terminalHandle: `term_${tab.id}`,
    agentPid: 100 + index
  }))
  /** Every pane reports; `pidOffset` moves each pane to another agent process. */
  const report = (
    state: 'working' | 'done',
    updatedAt: number,
    providerSession?: Session,
    pidOffset = 0
  ): void => {
    for (const pane of panes) {
      store.getState().setAgentStatus(
        pane.paneKey,
        { state, prompt: 'Work', agentType: 'codex' },
        'Codex',
        { updatedAt, stateStartedAt: updatedAt },
        {
          tabId: pane.tabId,
          worktreeId: pane.worktreeId,
          terminalHandle: pane.terminalHandle,
          agentPid: pane.agentPid + pidOffset
        },
        providerSession ? { providerSession } : undefined
      )
    }
  }
  return { store, report }
}

function counts(
  state: AppState,
  archived: readonly string[],
  membership: Record<string, string> = {}
) {
  const sessions = buildSidebarSessions(state)
  const metadata = { ...emptySessionFolderMetadata(), membership }
  const tree = buildSessionSidebarTree({
    sessions,
    metadata,
    view: { ...emptySessionSidebarView(), archived: [...archived] },
    snapshot: EMPTY_AGENT_PANE_SNAPSHOT,
    query: '',
    showHidden: false
  })
  return { rows: sessions.length, archived: tree.archivedCount, sessions, metadata }
}

describe('stable conversation identity (Astra F4)', () => {
  it('keeps rows and Archived at [1,1,1] across a metadata-less turn of one incarnation', () => {
    const { store, report } = conversationInTabs(['a', 'b'])
    const same = { key: 'session_id' as const, id: 'same' }
    report('working', 100, same)
    const first = counts(store.getState(), [])
    expect(first.rows).toBe(1)
    const archived = [first.sessions[0]!.sessionKey!]

    const rows: number[] = []
    const archivedCounts: number[] = []
    const sample = (): void => {
      const now = counts(store.getState(), archived)
      rows.push(now.rows)
      archivedCounts.push(now.archived)
    }
    sample()
    report('done', 150)
    report('working', 200)
    // The new turn carries no resume metadata (the replacement safety case still holds).
    const entries = Object.values(store.getState().agentStatusByPaneKey)
    expect(entries.map((entry) => entry.providerSession)).toEqual([undefined, undefined])
    sample()
    report('working', 250, same)
    sample()

    // Before the fix: rows [1,2,1], Archived [1,0,1].
    expect(rows).toEqual([1, 1, 1])
    expect(archivedCounts).toEqual([1, 1, 1])
  })

  it('gives a positively identified replacement conversation its own row and archive state', () => {
    const { store, report } = conversationInTabs(['a', 'b'])
    report('working', 100, { key: 'session_id', id: 'same' })
    const archived = [counts(store.getState(), []).sessions[0]!.sessionKey!]
    report('done', 150)
    report('working', 200, { key: 'session_id', id: 'replacement' })

    const after = counts(store.getState(), archived)
    expect(after.rows).toBe(1)
    expect(after.sessions[0]!.sessionKey).not.toBe(archived[0])
    expect(after.archived).toBe(0)
  })

  // Why: a finished agent's row can outlive it in a reused pane (an SSH pane that skipped its
  // end-of-command signal, a clear ignored for a finished row); the next agent is a new one.
  it('never gives a new agent in a reused pane the old conversation’s row, Archived or folder', () => {
    const { store, report } = conversationInTabs(['a'])
    report('working', 100, { key: 'session_id', id: 'old' })
    report('done', 150)
    const old = counts(store.getState(), []).sessions[0]!.sessionKey!
    const folder = 'folder-1'

    report('working', 200, undefined, 1)
    const fresh = counts(store.getState(), [old], { [old]: folder })
    expect(fresh.sessions[0]!.sessionKey).not.toBe(old)
    expect(fresh.archived).toBe(0)
    expect(getSessionFolderId(fresh.metadata, fresh.sessions[0]!.sessionKey!)).toBeNull()
    const provisional = fresh.sessions[0]!.sessionKey!

    // Its own session arrives: its filing moves to its own key, never onto the old one.
    report('working', 250, { key: 'session_id', id: 'new' }, 1)
    const [named] = counts(store.getState(), [old]).sessions
    expect(named!.folderKeyMigration).toEqual({ from: provisional, to: named!.sessionKey })
    expect(named!.sessionKey).not.toBe(old)
  })
})

describe('ledger identities on a paired receiver (addendum F1, F21)', () => {
  const ownerPane = (n: number): string =>
    makePaneKey(`0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, SESSION_TEST_LEAF)

  it('keeps provider-less panes apart, before and after their frames, and deletes only one', () => {
    const records = [1, 2, 3].map((n) => paneRecord(ownerPane(n)))
    const source = pairedSource()
    Object.assign(source, ledgerSlices([ledgerBucket(records)]))
    const keys = records.map((record) =>
      mirroredConversationRowKey(LEDGER_ENV, SESSION_TEST_WORKTREE, record)
    )
    expect(new Set(keys).size).toBe(3)
    expect(keys[0]).toContain(`p:pane:${ownerPane(1)}`)
    expect(buildSidebarSessions(source).map((row) => row.rowKey)).toEqual(keys)

    // Their dormant frames arrive: the rows move onto the mirror tabs under the same keys.
    for (const record of records) {
      addMirrorTab(source, record.tabId, null)
    }
    const framed = buildSidebarSessions(source)
    expect(framed.map((row) => row.rowKey)).toEqual(keys)
    expect(framed.map((row) => row.tabId)).toEqual(
      records.map((record) => toWebTerminalSurfaceTabId(record.tabId!))
    )

    // The owner deletes the second (its tombstone empties that record from the bucket).
    Object.assign(source, ledgerSlices([ledgerBucket([records[0]!, records[2]!])]))
    expect(buildSidebarSessions(source).map((row) => row.rowKey)).toEqual([keys[0], keys[2]])
  })

  it('keeps two Pi conversations sharing a session id apart, archive and folder included', () => {
    const folder = '00000000-0000-4000-8000-0000000000f1'
    const pi = (path: string, overrides: Parameters<typeof ledgerRecord>[1]) =>
      ledgerRecord('shared', {
        agent: 'pi',
        conversation: conversationDigest('shared', 'pi', SESSION_TEST_WORKTREE, path),
        ...overrides
      })
    const first = pi('/notes/a.jsonl', { archived: { archived: true }, folderId: folder })
    const second = pi('/notes/b.jsonl', { archived: { archived: false }, folderId: null })
    const source = pairedSource()
    // This computer's own record of the first one folds into it, never into the second.
    const capture = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)
    source.sleepingAgentSessionsByPaneKey[capture] = {
      paneKey: capture,
      tabId: capture.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'pi',
      providerSession: { key: 'session_id', id: 'shared', transcriptPath: '/notes/a.jsonl' },
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    Object.assign(source, ledgerSlices([ledgerBucket([first, second])]))

    const rows = buildSidebarSessions(source)
    expect(rows.map((row) => row.rowKey)).toEqual([
      mirroredConversationRowKey(LEDGER_ENV, SESSION_TEST_WORKTREE, first),
      mirroredConversationRowKey(LEDGER_ENV, SESSION_TEST_WORKTREE, second)
    ])
    expect(rows.map((row) => row.ownerArchive?.archived)).toEqual([true, false])
    expect(rows.map((row) => row.mirroredConversation?.folderIdByOwner)).toEqual([folder, null])
  })
})
