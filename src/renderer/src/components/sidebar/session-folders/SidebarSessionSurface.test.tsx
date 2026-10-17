// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
const mocks = vi.hoisted(() => ({ surface: 'sessions', setSurface: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ sidebarSessionSurface: mocks.surface, setSidebarSessionSurface: mocks.setSurface })
}))
vi.mock('./SessionSidebar', () => ({
  default: ({ technical }: { technical?: boolean }) => (
    <div>{technical ? 'Technical tree' : 'Conversation tree'}</div>
  )
}))
vi.mock('../team-sessions/use-session-ledger-sidebar', () => ({ useSessionLedgerSidebar: () => 2 }))
vi.mock('../team-sessions/CollisionBanner', () => ({ CollisionBanner: () => null }))
vi.mock('../team-sessions/TeamSessionsSidebar', () => ({ default: () => <div>Team tree</div> }))
vi.mock('@/components/goals-todos/GoalsTodosSidebar', () => ({
  default: () => <div>Goals tree</div>
}))
import { SidebarSessionSurface } from './SidebarSessionSurface'
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
function mount() {
  return render(
    <TooltipProvider>
      <SidebarSessionSurface>
        <div>Workspace tree</div>
      </SidebarSessionSurface>
    </TooltipProvider>
  )
}
it.each([
  ['sessions', 'Conversation tree'],
  ['team', 'Team tree'],
  ['technical', 'Technical tree'],
  ['goals', 'Goals tree'],
  ['workspaces', 'Workspace tree']
])('renders only the %s surface', async (surface, content) => {
  mocks.surface = surface
  mount()
  await screen.findByText(content)
  for (const other of [
    'Conversation tree',
    'Technical tree',
    'Goals tree',
    'Workspace tree',
    'Team tree'
  ]) {
    if (other !== content) {
      expect(screen.queryByText(other)).toBeNull()
    }
  }
})
it('offers Conversations and People followed by separate Sessions and Workspaces buttons', () => {
  mocks.surface = 'sessions'
  mount()
  const group = screen.getByRole('radiogroup', { name: 'Sidebar view' })
  expect(
    within(group)
      .getAllByRole('radio')
      .map((button) => button.textContent)
  ).toEqual(['Conversations', '2People'])
  fireEvent.click(screen.getByRole('radio', { name: /People/ }))
  expect(mocks.setSurface).toHaveBeenLastCalledWith('team')
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }))
  expect(mocks.setSurface).toHaveBeenLastCalledWith('technical')
  fireEvent.click(screen.getByRole('button', { name: 'Goals & to-dos' }))
  expect(mocks.setSurface).toHaveBeenLastCalledWith('goals')
  fireEvent.click(screen.getByRole('button', { name: 'Developer Workspaces' }))
  expect(mocks.setSurface).toHaveBeenLastCalledWith('workspaces')
})
// Why: the wrench now means Build + Review, so the workspaces toggle draws a git folder.
it('draws the Developer Workspaces toggle as a git folder, not a wrench', () => {
  mocks.surface = 'sessions'
  mount()
  const toggle = screen.getByRole('button', { name: 'Developer Workspaces' })
  expect(toggle.querySelector('.lucide-folder-git-2')).not.toBeNull()
  expect(toggle.querySelector('.lucide-wrench')).toBeNull()
})
// Why: this tab is the sidebar's one "Conversations" — no heading or group label repeats it.
it('says Conversations exactly once, on the tab', async () => {
  mocks.surface = 'sessions'
  mount()
  await screen.findByText('Conversation tree')
  expect(screen.getAllByText('Conversations')).toHaveLength(1)
  expect(screen.getByRole('radio', { name: 'Conversations' })).toBeTruthy()
})
// Why: at the default 280px width the three view buttons were laid out past the sidebar's edge,
// hidden yet focusable, so Tab scrolled the whole sidebar sideways (live acceptance: 383px of
// content in a 280px sidebar). They now wrap onto their own line, and the labels can shrink.
it('wraps the view buttons onto their own line instead of past the sidebar edge', () => {
  mocks.surface = 'sessions'
  mount()
  const group = screen.getByRole('radiogroup', { name: 'Sidebar view' })
  const row = group.parentElement!
  expect(row.classList.contains('flex-wrap')).toBe(true)
  expect(group.classList.contains('min-w-0')).toBe(true)
  const buttons = screen.getByRole('button', { name: 'Sessions' }).parentElement!
  expect(buttons.parentElement).toBe(row)
  expect(
    within(buttons)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
  ).toEqual(['Sessions', 'Goals & to-dos', 'Developer Workspaces'])
  for (const radio of within(group).getAllByRole('radio')) {
    expect(radio.classList.contains('min-w-0')).toBe(true)
    expect(radio.classList.contains('shrink-0')).toBe(false)
    expect(radio.querySelector('.truncate')).not.toBeNull()
  }
})
// Why: routines are conversations with a schedule; they have no tab of their own any more.
it('has no Routines tab', () => {
  mocks.surface = 'sessions'
  mount()
  expect(screen.queryByRole('radio', { name: 'Routines' })).toBeNull()
})
