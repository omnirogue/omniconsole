// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { AddNextButton } from '@/components/next-step/AddNextButton'
import { SessionSidebarRowActions } from '@/components/sidebar/session-folders/SessionSidebarRowActions'
import { UP_NEXT_COMPOSER_ENABLED } from './up-next-composer-flag'
import { UpNextControls } from './UpNextControls'

const chains = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => chains.current }))
vi.mock('./UpNextSubject', () => ({ UpNextSubject: () => <div>Up next composer</div> }))
vi.mock('@/components/next-step/SessionPlanLock', () => ({ SessionPlanLock: () => null }))
vi.mock('@/lib/session-folders', () => ({
  getSessionFolderId: () => null,
  isSavedSessionFolder: () => false,
  SAVED_SESSIONS_FOLDER_ID: 'saved'
}))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: Object.assign((select: (value: unknown) => unknown) => select({}), {
    getState: () => ({ moveSession: vi.fn() })
  })
}))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: (select: (value: unknown) => unknown) => select({ archived: [] })
}))
vi.mock('@/components/sidebar/session-folders/PersonalHideButton', () => ({
  PersonalHideButton: () => null
}))
vi.mock('@/components/sidebar/session-folders/ConversationArchiveButton', () => ({
  ConversationArchiveButton: () => null
}))
afterEach(() => {
  cleanup()
  chains.current = null
})

const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Conversation',
  workspaceLabel: 'Workspace',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
} as SidebarSession

it('ships with the hand composer off', () => {
  expect(UP_NEXT_COMPOSER_ENABLED).toBe(false)
})

it('offers no ＋ to start a plan by hand, on a session or a card', () => {
  const { container } = render(
    <>
      <UpNextControls subject={{ kind: 'session', session }} />
      <AddNextButton subject={{ kind: 'card', item: { task_id: 't', title: 'Card' } as never }} />
    </>
  )
  expect(container.innerHTML).toBe('')
})

it('keeps the plan a conversation filed viewable from its row', () => {
  chains.current = { id: 'chain', outcomeSet: { outcomes: [] } } as unknown as SessionChain
  render(<UpNextControls subject={{ kind: 'session', session }} />)
  expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()
})

it('leaves Up next out of the ⋮ menu', () => {
  render(
    <TooltipProvider>
      <SessionSidebarRowActions
        session={session}
        chain={null}
        queued={false}
        queueRefusal={null}
        hidden={false}
        onToggleHidden={vi.fn()}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
  expect(screen.getByRole('menu')).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Up next' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Up next' })).toBeNull()
})
