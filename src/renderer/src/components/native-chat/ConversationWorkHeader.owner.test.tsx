// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { ConversationWorkHeader } from './ConversationWorkHeader'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord
} from '@/lib/sidebar-session-test-fixtures'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const observed = vi.hoisted(() => ({
  sessions: [] as SidebarSession[],
  chains: [],
  routineTabId: null as string | null
}))
vi.mock('./NativeChatViewSwitch', () => ({ NativeChatViewSwitch: () => null }))
vi.mock('@/components/sidebar/routines/routine-conversation-state', () => ({
  useRoutineForTab: (tabId: string) => (tabId === observed.routineTabId ? { tabId } : undefined)
}))
vi.mock('@/lib/session-chain-registry', () => ({
  useShownSessionChains: () => observed.chains,
  useSessionChainForRow: () => null
}))
vi.mock('@/lib/session-folder-key-migration', () => ({ applySessionFolderKeyMigrations: vi.fn() }))
vi.mock('@/components/sidebar/routines/RoutineConversationHeader', () => ({
  RoutineConversationHeader: () => null
}))
vi.mock('@/components/session-activity/SessionActivityPanel', () => ({
  SessionActivityPanel: () => null
}))
vi.mock('@/components/next-action/UpNextSubject', () => ({
  UpNextSubject: ({ subject }: { subject: { session: SidebarSession } }) => {
    observed.sessions.push(subject.session)
    return <section aria-label="Owned work controls">{subject.session.paneKey}</section>
  }
}))
afterEach(() => {
  cleanup()
  observed.sessions = []
  observed.routineTabId = null
})

it('keeps the resumed pane work controls mounted when its older provider tab remains open', () => {
  const source = sessionTestSource()
  const original = addSessionTestRecord(source, addSessionTestTab(source, 'original'))
  const resumed = addSessionTestRecord(source, addSessionTestTab(source, 'resumed'))
  useAppStore.setState(source)
  const header = (paneKey: string, tabId: string) => (
    <TooltipProvider>
      <ConversationWorkHeader worktreeId="workspace" paneKey={paneKey} tabId={tabId} />
    </TooltipProvider>
  )
  const view = render(header(resumed.paneKey, resumed.tabId!))
  const toggle = screen.getByRole('button', { name: 'Session context & outcome' })
  if (toggle.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(toggle)
  }
  expect(screen.getByRole('region', { name: 'Owned work controls' }).textContent).toBe(
    resumed.paneKey
  )
  expect(view.container.querySelector('[data-conversation-header-row]')).not.toBeNull()
  expect(observed.sessions.at(-1)).toMatchObject({
    tabId: resumed.tabId,
    paneKey: resumed.paneKey,
    providerSession: resumed.providerSession,
    hostId: 'local'
  })
  view.rerender(header(original.paneKey, original.tabId!))
  if (toggle.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(toggle)
  }
  expect(screen.getByRole('region', { name: 'Owned work controls' }).textContent).toBe(
    original.paneKey
  )
  view.rerender(header('resumed:unowned', resumed.tabId!))
  // Why the marker, not the style: happy-dom drops calc(var(...)) from inline styles; the
  // gutter hook's own test covers the reserved width.
  expect(document.querySelector('[data-conversation-header-row]')).not.toBeNull()
  expect(screen.queryByRole('region', { name: 'Owned work controls' })).toBeNull()
})

it('leaves the Up next chain off a routine conversation', () => {
  const source = sessionTestSource()
  const routineTab = addSessionTestRecord(source, addSessionTestTab(source, 'routine'))
  useAppStore.setState(source)
  observed.routineTabId = routineTab.tabId!
  render(
    <TooltipProvider>
      <ConversationWorkHeader
        worktreeId="workspace"
        paneKey={routineTab.paneKey}
        tabId={routineTab.tabId!}
      />
    </TooltipProvider>
  )
  // Why the marker, not the style: happy-dom drops calc(var(...)) from inline styles; the
  // gutter hook's own test covers the reserved width.
  expect(document.querySelector('[data-conversation-header-row]')).not.toBeNull()
  expect(screen.queryByRole('region', { name: 'Owned work controls' })).toBeNull()
  expect(observed.sessions).toEqual([])
})
