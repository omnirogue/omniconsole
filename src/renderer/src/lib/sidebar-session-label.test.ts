import { describe, expect, it } from 'vitest'
import { firstSessionLabel, sleepingRecordSessionLabel } from './sidebar-session-label'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions } from './sidebar-sessions'

describe('sidebar row label sources (session parity, addendum F2)', () => {
  it('names where a terminal row label came from, in the sidebar order', () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source, 'tab-a')
    const row = () => buildSidebarSessions(source)[0]
    expect(row()).toMatchObject({ label: 'Session tab-a', labelSource: 'terminal' })

    tab.generatedTitle = 'Fix the login bug'
    expect(row()).toMatchObject({ label: 'Fix the login bug', labelSource: 'generated' })

    source.terminalLayoutsByTabId['tab-a'] = {
      ...source.terminalLayoutsByTabId['tab-a']!,
      titlesByLeafId: { [SESSION_TEST_LEAF]: 'Pane name' }
    }
    expect(row()).toMatchObject({ label: 'Pane name', labelSource: 'terminal' })

    tab.customTitle = 'My rename'
    expect(row()).toMatchObject({ label: 'My rename', labelSource: 'custom' })
  })

  it('reads a placeholder title as the agent’s own name', () => {
    const source = sessionTestSource()
    addSessionTestTab(source, 'tab-a').title = 'Terminal 3'
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      label: 'codex conversation',
      labelSource: 'agent'
    })
  })

  it('marks a record row named by its prompt or agent as agent, by its terminal title as terminal', () => {
    const source = sessionTestSource()
    const record = addSessionTestRecord(source, addSessionTestTab(source, 'tab-a'), 'provider-a')
    source.tabsByWorktree[SESSION_TEST_WORKTREE] = []
    delete source.terminalLayoutsByTabId['tab-a']
    expect(buildSidebarSessions(source)[0]).toMatchObject({
      tabId: null,
      label: 'Session tab-a',
      labelSource: 'terminal'
    })
    delete record.terminalTitle
    // This computer keeps showing the prompt; the source says it is no title to share.
    expect(buildSidebarSessions(source)[0]).toMatchObject({ label: 'Work', labelSource: 'agent' })

    expect(sleepingRecordSessionLabel({ prompt: '', agent: 'claude' })).toEqual({
      label: 'claude',
      labelSource: 'agent'
    })
  })

  it('picks like `a || b || last`, keeping the last candidate even when empty', () => {
    expect(
      firstSessionLabel([
        [null, 'custom'],
        ['', 'generated'],
        ['Tab', 'terminal']
      ])
    ).toEqual({ label: 'Tab', labelSource: 'terminal' })
    expect(
      firstSessionLabel([
        [undefined, 'custom'],
        ['', 'terminal']
      ])
    ).toEqual({ label: '', labelSource: 'terminal' })
  })
})
