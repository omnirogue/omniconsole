// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionDetailsFacts } from './use-session-details-facts'
import { SessionDetails } from './SessionDetails'
import { nextActionChainFixture } from './next-action-fixture'
import type { SidebarSession } from '@/lib/sidebar-sessions'

vi.mock('@/store', () => {
  const state = {
    agentStatusByPaneKey: {},
    sshTargetLabels: {},
    gitStatusByWorktree: {
      'folder:1': Array.from({ length: 7 }, (_, i) => ({ path: `file${i}` }))
    },
    getKnownWorktreeById: () => ({ path: '/workspace' }),
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  return {
    useAppStore: Object.assign((select: (state: unknown) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: (select: (state: unknown) => unknown) =>
    select({ metadata: { folders: [], membership: {} } })
}))
vi.mock('@/store/session-task-store', () => ({ useSessionTask: () => null }))
vi.mock('@/components/tasks/CreateTaskDialog', () => ({ CreateTaskDialog: () => null }))
vi.mock('@/components/tasks/AttachToTaskDialog', () => ({ AttachToTaskDialog: () => null }))
vi.mock('@/components/tasks/SessionTaskSheet', () => ({ SessionTaskSheet: () => null }))
afterEach(cleanup)
it('shows seven changed files even when the plan pins two file conditions', () => {
  const chain = nextActionChainFixture()
  chain.outcomeSet!.outcomes[0]!.conditions.push({
    id: 'second-file',
    kind: 'file',
    target: 'dist/second'
  })
  const session = {
    rowKey: 'row',
    sessionKey: 'session',
    worktreeId: 'folder:1',
    hostId: 'local',
    tabId: 'tab',
    paneKey: 'tab:leaf',
    kind: 'terminal',
    label: 'Work',
    workspaceLabel: 'Workspace',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  } satisfies SidebarSession
  function Facts() {
    const facts = useSessionDetailsFacts(session, chain)
    return <SessionDetails facts={facts} />
  }
  render(<Facts />)
  fireEvent.click(screen.getByText('More'))
  expect(document.querySelector('[data-next-action-fact="files"]')?.textContent).toBe(
    'Files7 changed'
  )
})
