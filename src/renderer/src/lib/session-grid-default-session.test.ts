import { describe, expect, it } from 'vitest'
import { selectGridDefaultSession } from './session-grid-default-session'
import type { SidebarSession } from './sidebar-sessions'

const row = (
  paneKey: string,
  hostId: SidebarSession['hostId'] = 'local',
  unavailable = false
): SidebarSession => ({
  rowKey: `${hostId}:${paneKey}`,
  sessionKey: paneKey,
  worktreeId: 'wt',
  hostId,
  tabId: paneKey,
  paneKey,
  kind: 'terminal',
  label: paneKey,
  workspaceLabel: 'Workspace',
  agent: 'codex',
  unavailable,
  folderKeyMigration: null
})
describe('initial command-center live session', () => {
  it('chooses the newest available needs-you session without binding a remote key collision', () => {
    const local = row('new')
    const remote = row('new', 'ssh:other')
    expect(
      selectGridDefaultSession(
        [remote, row('old'), row('blocked', 'local', true), local],
        [
          { paneKey: 'old', stateChangedAt: 1, hostId: 'local' },
          { paneKey: 'new', stateChangedAt: 2, hostId: 'local' },
          { paneKey: 'blocked', stateChangedAt: 3, hostId: 'local' }
        ],
        { worktreeId: null, tabId: null, hostId: null }
      )
    ).toBe(local)
  })
  it('matches SSH ownership and refuses unresolved attention or focus', () => {
    const remote = row('same', 'ssh:other')
    const sessions = [row('same'), remote]
    expect(
      selectGridDefaultSession(
        sessions,
        [{ paneKey: 'same', stateChangedAt: 2, hostId: 'ssh:other' }],
        { worktreeId: null, tabId: null, hostId: null }
      )
    ).toBe(remote)
    expect(
      selectGridDefaultSession(sessions, [{ paneKey: 'same', stateChangedAt: 2, hostId: null }], {
        worktreeId: 'wt',
        tabId: 'same',
        hostId: null
      })
    ).toBeNull()
  })
  it('falls back to the session last focused in the workspace, or keeps the chooser', () => {
    const focused = row('focused')
    expect(
      selectGridDefaultSession([row('other'), focused], [], {
        worktreeId: 'wt',
        tabId: 'focused',
        hostId: 'local'
      })
    ).toBe(focused)
    expect(
      selectGridDefaultSession([focused], [], { worktreeId: null, tabId: null, hostId: null })
    ).toBeNull()
  })
})
