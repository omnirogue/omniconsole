/** @vitest-environment happy-dom */
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { clearLaunchIntentDrag, getLaunchIntentDrag } from '@/lib/launcher-intent-drag'
import { LAUNCH_INTENT_DRAG_TYPE } from '../../../../../shared/session-sidebar-drag-types'
import { LauncherPalette } from './LauncherPalette'

// The real account column needs the store; a leaf that picks account, model and effort stands in.
vi.mock('./new-conversation/NewConversationAccountsColumn', () => ({
  NewConversationAccountsColumn: ({
    agent,
    local,
    start
  }: {
    agent: string
    local: boolean
    start: (pick: unknown) => void
  }) => (
    <DropdownMenuItem
      disabled={!local}
      onSelect={() => start({ agent, account: 'acct', model: 'model', effort: 'high' })}
    >
      Account model effort
    </DropdownMenuItem>
  )
}))

const start = vi.fn()
const props = {
  capabilities: [
    { id: 'codex' as const, label: 'Codex', status: 'usable', models: [] },
    { id: 'kimi' as const, label: 'Kimi', status: 'usable', models: [] },
    { id: 'claude' as const, label: 'Claude', status: 'unavailable', models: [] },
    // Usable, but not a launcher provider: the "+" menu does not list it either.
    { id: 'opencode' as const, label: 'OpenCode', status: 'usable', models: [] }
  ],
  rows: { claude: [], codex: [] },
  local: true,
  starting: false,
  launchError: '',
  start
}
afterEach(() => {
  cleanup()
  clearLaunchIntentDrag()
  start.mockClear()
  vi.useRealTimers()
})
function palette(overrides: Partial<typeof props> = {}) {
  return render(
    <TooltipProvider>
      <LauncherPalette {...props} {...overrides} />
    </TooltipProvider>
  )
}

it('renders only usable launcher providers, in launcher order', () => {
  palette()
  expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
    'Launch Codex here',
    'Launch Kimi here'
  ])
})

it('a click launches that provider with the launcher defaults', () => {
  palette()
  fireEvent.click(screen.getByRole('button', { name: 'Launch Codex here' }))
  expect(start).toHaveBeenCalledExactlyOnceWith({ agent: 'codex' })
})

it('right-click opens the provider row submenu and a leaf launches its pick', () => {
  palette()
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Launch Codex here' }), {
    clientX: 40,
    clientY: 60
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Account model effort' }))
  expect(start).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    account: 'acct',
    model: 'model',
    effort: 'high'
  })
  expect(screen.queryByRole('menu')).toBeNull()
})

it('off-host the account leaf stays unavailable, as in the menu', () => {
  palette({ local: false })
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Launch Codex here' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Account model effort' }))
  expect(start).not.toHaveBeenCalled()
})

it('right-click on a provider without a submenu does nothing', () => {
  palette()
  const event = fireEvent.contextMenu(screen.getByRole('button', { name: 'Launch Kimi here' }))
  expect(event).toBe(false)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(start).not.toHaveBeenCalled()
})

it('a drag carries the provider as a launch intent and clears it at dragend', () => {
  palette()
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  const setData = vi.fn()
  const dragStart = createEvent.dragStart(button, { dataTransfer: { setData } })
  fireEvent(button, dragStart)
  expect(setData).toHaveBeenCalledWith(LAUNCH_INTENT_DRAG_TYPE, '{"agent":"codex"}')
  expect((dragStart as DragEvent).dataTransfer?.effectAllowed).toBe('copy')
  expect(getLaunchIntentDrag()).toEqual({ agent: 'codex' })
  fireEvent.dragEnd(button)
  expect(getLaunchIntentDrag()).toBeNull()
  expect(start).not.toHaveBeenCalled()
})

it('a touch long-press opens the submenu and the release does not also launch', () => {
  vi.useFakeTimers()
  palette()
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  fireEvent.pointerDown(button, { pointerType: 'touch', button: 0, clientX: 40, clientY: 60 })
  act(() => {
    vi.advanceTimersByTime(600)
  })
  expect(screen.getByRole('menuitem', { name: 'Account model effort' })).toBeTruthy()
  fireEvent.click(button)
  expect(start).not.toHaveBeenCalled()
})

it('a mouse press held still is not a long-press', () => {
  vi.useFakeTimers()
  palette()
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  fireEvent.pointerDown(button, { pointerType: 'mouse', button: 0 })
  act(() => {
    vi.advanceTimersByTime(600)
  })
  expect(screen.queryByRole('menu')).toBeNull()
})

it('LP-03: an icon removed mid-drag ends its drag, so nothing stays highlighted', () => {
  const { rerender } = palette()
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  fireEvent.dragStart(button, { dataTransfer: { setData: vi.fn() } })
  expect(getLaunchIntentDrag()).toEqual({ agent: 'codex' })
  // Codex stops being usable while the drag is in flight; its dragend will never reach React.
  rerender(
    <TooltipProvider>
      <LauncherPalette {...props} capabilities={[]} />
    </TooltipProvider>
  )
  expect(getLaunchIntentDrag()).toBeNull()
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

it('LP-04: Escape closes the right-click menu and returns focus to the provider icon', async () => {
  palette()
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  button.focus()
  fireEvent.contextMenu(button, { clientX: 40, clientY: 60 })
  await settle()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await settle()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(button)
})

it('LP-04: choosing an item returns focus to the provider icon', async () => {
  palette()
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  fireEvent.contextMenu(button, { clientX: 40, clientY: 60 })
  await settle()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Account model effort' }))
  await settle()
  expect(start).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(button)
})

it('LP-04: a click on another control keeps the focus that click gave', async () => {
  render(
    <TooltipProvider>
      <LauncherPalette {...props} />
      <input aria-label="Elsewhere" />
    </TooltipProvider>
  )
  const button = screen.getByRole('button', { name: 'Launch Codex here' })
  fireEvent.contextMenu(button, { clientX: 40, clientY: 60 })
  await settle()
  const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' })
  fireEvent.pointerDown(elsewhere)
  elsewhere.focus()
  await settle()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(elsewhere)
})
