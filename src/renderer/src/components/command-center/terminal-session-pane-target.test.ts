import { describe, expect, it } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { paneSessionFolderKey } from '@/lib/session-folder-identity'
import type { Tab } from '../../../../shared/tab-types'
import { canBorrowSessionPane } from './terminal-session-pane-target'

const paneKey = 'terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tab: Tab = {
  id: 'unified',
  entityId: 'terminal',
  worktreeId: 'folder',
  contentType: 'terminal',
  executionHostId: 'runtime:owner',
  groupId: 'group',
  label: 'Codex',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: paneSessionFolderKey('runtime:owner', 'folder', paneKey),
  worktreeId: 'folder',
  hostId: 'runtime:owner',
  tabId: 'terminal',
  paneKey,
  kind: 'terminal',
  agent: 'codex',
  label: 'Codex',
  workspaceLabel: 'folder',
  unavailable: false,
  folderKeyMigration: null
}
describe('host-qualified terminal pane identity', () => {
  it('borrows the owner tab, including a folder workspace', () => {
    expect(canBorrowSessionPane(session, tab, 'runtime:owner')).toBe(true)
  })
  it.each([
    { ...session, hostId: 'local' as const },
    { ...session, worktreeId: 'another' },
    { ...session, tabId: 'other-terminal' },
    { ...session, paneKey: 'other:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { ...session, sessionKey: paneSessionFolderKey('local', 'folder', paneKey) },
    { ...session, sessionKey: paneSessionFolderKey('runtime:owner', 'other', paneKey) },
    { ...session, sessionKey: 'invalid' },
    { ...session, unavailable: true }
  ])('rejects conflicting identity and unreachable rows', (row) => {
    expect(canBorrowSessionPane(row, tab, 'runtime:owner')).toBe(false)
  })
  it('does not bind a remote-only row to a local tab', () => {
    expect(canBorrowSessionPane(session, undefined, null)).toBe(false)
    expect(canBorrowSessionPane(session, tab, 'local')).toBe(false)
  })
  it('allows plain shells with no conversation key, as the main view does', () => {
    expect(
      canBorrowSessionPane({ ...session, sessionKey: null, paneKey: null }, tab, 'runtime:owner')
    ).toBe(true)
  })
})
