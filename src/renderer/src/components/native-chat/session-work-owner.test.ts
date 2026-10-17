import { describe, expect, it } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sessionWorkOwner } from './session-work-owner'
const first: SidebarSession = {
  rowKey: 'one',
  sessionKey: 'one',
  hostId: 'local',
  worktreeId: 'folder:work',
  tabId: 'tab',
  paneKey: 'tab:first',
  kind: 'terminal',
  label: 'First agent',
  workspaceLabel: 'Work',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
const second = {
  ...first,
  rowKey: 'two',
  sessionKey: 'two',
  paneKey: 'tab:second',
  label: 'Second agent'
}
describe('session work rail owner', () => {
  it('follows the exact active split even if its sibling is listed first', () => {
    expect(sessionWorkOwner([first, second], 'tab:second', 'tab')).toBe(second)
    expect(sessionWorkOwner([second, first], 'tab:first', 'tab')).toBe(first)
  })
  it('does not borrow sibling authority when an active leaf has no agent', () => {
    expect(sessionWorkOwner([first], 'tab:plain-shell', 'tab')).toBeUndefined()
  })
  it('resolves an ACP tab without inventing a PTY', () => {
    const structured = { ...first, kind: 'structured' as const, paneKey: null, tabId: 'acp' }
    expect(sessionWorkOwner([first, structured], 'structured:acp', 'acp')).toBe(structured)
    expect(sessionWorkOwner([structured], 'tab:plain-shell', 'tab')).toBeUndefined()
  })
})
