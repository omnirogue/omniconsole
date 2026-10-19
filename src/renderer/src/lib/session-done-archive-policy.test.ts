import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { SessionFolderMetadata } from './session-folders'
import type { SessionSidebarView } from './session-sidebar-view'
import type { PursuitSidebarTreeRow } from './session-sidebar-tree-rows'

vi.mock('./account-sync/session-organization-intent', () => ({
  sessionOrganizationScope: () => 'sal'
}))
vi.mock('./session-folders', () => ({ isSessionSaved: () => false }))

const { sessionEmptyArchiveRevision } = await import('./session-done-archive-policy')

// An agent launched it: only an agent's blank session is cleaned up (Sal, 2026-10-19).
const metadata = {
  folders: [],
  membership: {},
  agentSessions: { 'session-1': 1 }
} as unknown as SessionFolderMetadata
const view = { version: 1, collapsed: [], hidden: [], order: [] } as unknown as SessionSidebarView

function row(overrides: Partial<PursuitSidebarTreeRow> = {}): PursuitSidebarTreeRow {
  return {
    session: {
      rowKey: 'row-1',
      sessionKey: 'session-1',
      worktreeId: 'w1',
      hostId: 'local',
      tabId: 'tab-1',
      paneKey: 'term:tab-1:pane-1',
      unavailable: false,
      launchPending: false
    },
    folderId: null,
    attention: null,
    state: null,
    waitingUntil: null,
    ...overrides
  } as PursuitSidebarTreeRow
}

function appState(overrides: Partial<AppState> = {}): AppState {
  return {
    workspaceSessionReady: true,
    agentStatusByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    ...overrides
  } as unknown as AppState
}

describe('sessionEmptyArchiveRevision', () => {
  it('never vouches for a blank session a person started: it stays until they close it', () => {
    const person = { folders: [], membership: {} } as unknown as SessionFolderMetadata
    expect(sessionEmptyArchiveRevision(row(), appState(), person, view, true)).toBeNull()
  })

  it('vouches for an untouched pane, including one whose SessionStart alone reported done', () => {
    expect(sessionEmptyArchiveRevision(row(), appState(), metadata, view, true)).not.toBeNull()
    const started = appState({
      agentStatusByPaneKey: {
        'term:tab-1:pane-1': { state: 'done', prompt: '', updatedAt: 10 }
      }
    } as unknown as Partial<AppState>)
    const completed = row({ completed: { reason: 'finished', at: 10 }, pursuitState: 'done' })
    expect(sessionEmptyArchiveRevision(completed, started, metadata, view, true)).not.toBeNull()
  })

  it('changes on a status update and on terminal input, and clears on a prompt, work or a hold', () => {
    const before = sessionEmptyArchiveRevision(row(), appState(), metadata, view, true)
    const typed = appState({ lastTerminalInputAtByPaneKey: { 'term:tab-1:pane-1': 99 } })
    expect(sessionEmptyArchiveRevision(row(), typed, metadata, view, true)).not.toBe(before)
    const reported = appState({
      agentStatusByPaneKey: { 'term:tab-1:pane-1': { state: 'done', prompt: '', updatedAt: 5 } }
    } as unknown as Partial<AppState>)
    expect(sessionEmptyArchiveRevision(row(), reported, metadata, view, true)).not.toBe(before)
    for (const status of [
      { state: 'done', prompt: 'fix the parser', updatedAt: 5 },
      { state: 'working', prompt: '', updatedAt: 5 },
      { state: 'blocked', prompt: '', updatedAt: 5 },
      { state: 'done', prompt: '', updatedAt: 5, workingMode: 'monitoring' }
    ]) {
      const busy = appState({
        agentStatusByPaneKey: { 'term:tab-1:pane-1': status }
      } as unknown as Partial<AppState>)
      expect(
        sessionEmptyArchiveRevision(row(), busy, metadata, view, true),
        status.state
      ).toBeNull()
    }
    for (const held of [
      row({ attention: {} as PursuitSidebarTreeRow['attention'] }),
      row({ unreadCompletion: true }),
      row({ waitingUntil: '2026-09-27T00:00:00.000Z' }),
      row({ backgroundTaskCount: 1 }),
      row({ archived: true })
    ]) {
      expect(sessionEmptyArchiveRevision(held, appState(), metadata, view, true)).toBeNull()
    }
    expect(sessionEmptyArchiveRevision(row(), appState(), metadata, view, false)).toBeNull()
    expect(
      sessionEmptyArchiveRevision(
        row(),
        appState({ workspaceSessionReady: false }),
        metadata,
        view,
        true
      )
    ).toBeNull()
  })
})
