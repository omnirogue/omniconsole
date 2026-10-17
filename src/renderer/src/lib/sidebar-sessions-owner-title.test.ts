import { describe, expect, it } from 'vitest'
import { buildSidebarSessions } from './sidebar-sessions'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  sessionTestSource
} from './sidebar-session-test-fixtures'

function pairedMirror() {
  const source = sessionTestSource()
  source.repos[0]!.executionHostId = 'runtime:studio'
  source.worktreesByRepo['repo-a']![0]!.hostId = 'runtime:studio'
  const tab = addSessionTestTab(source)
  tab.title = 'Golden Stub Agent'
  tab.runtimeOwnerTabId = 'owner-tab'
  return { source, tab }
}

describe('a paired mirror row label', () => {
  it("shows the owner's name ahead of the terminal title", () => {
    const { source, tab } = pairedMirror()
    expect(buildSidebarSessions(source)[0]?.label).toBe('Golden Stub Agent')
    tab.runtimeOwnerTitleByLeafId = { [SESSION_TEST_LEAF]: 'Studio name' }
    expect(buildSidebarSessions(source)[0]?.label).toBe('Studio name')
  })

  it('keeps a rename made on this computer', () => {
    const { source, tab } = pairedMirror()
    tab.runtimeOwnerTitleByLeafId = { [SESSION_TEST_LEAF]: 'Studio name' }
    tab.customTitle = 'Mine'
    expect(buildSidebarSessions(source)[0]?.label).toBe('Mine')
  })
})
