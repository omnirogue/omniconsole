// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Placement from '@/lib/session-show-placement'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const placement = vi.hoisted(() => ({
  placeBesideInGrid: vi.fn(),
  placeBesideInWorkspace: vi.fn()
}))
const activateTabAndFocusPane = vi.hoisted(() => vi.fn())
const focusTerminalFromHost = vi.hoisted(() => vi.fn())
const activateSidebarSession = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/lib/session-show-placement', async (importOriginal) => ({
  ...(await importOriginal<typeof Placement>()),
  placeBesideInGrid: placement.placeBesideInGrid,
  placeBesideInWorkspace: placement.placeBesideInWorkspace
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane }))
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession }))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: vi.fn()
}))
vi.mock('./terminal-ui-routing-ipc-bridge', () => ({ focusTerminalFromHost }))

const { showSidebarSession } = await import('./session-show-request')
const { FOCUS_TERMINAL_PANE_EVENT } = await import('@/constants/terminal')

const LEAF = '0f8fad5b-d9cb-469f-a165-70867728950e'

const target: SidebarSession = {
  rowKey: 'row-target',
  sessionKey: 'target',
  worktreeId: 'wt-2',
  hostId: 'local',
  tabId: 'term-target',
  paneKey: `term-target:${LEAF}`,
  kind: 'terminal',
  label: 'Ads session',
  workspaceLabel: 'ads',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

function nextFrames(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('showSidebarSession', () => {
  it('splits a same-workspace conversation right and flashes its pane', () => {
    placement.placeBesideInWorkspace.mockReturnValue('split')
    const reply = showSidebarSession(target, { mode: 'beside', flash: true })
    expect(reply).toEqual({ placement: 'split', keptKeyboardFocus: false })
    expect(placement.placeBesideInGrid).not.toHaveBeenCalled()
    expect(activateTabAndFocusPane).toHaveBeenCalledWith('term-target', LEAF, {
      flashFocusedPane: true
    })
  })

  it('puts a conversation from another workspace in the Grid and flashes it there', async () => {
    placement.placeBesideInWorkspace.mockReturnValue(null)
    placement.placeBesideInGrid.mockReturnValue('grid')
    const events: unknown[] = []
    const listener = (event: Event): void => {
      events.push((event as CustomEvent).detail)
    }
    window.addEventListener(FOCUS_TERMINAL_PANE_EVENT, listener)
    const reply = showSidebarSession(target, { mode: 'beside', flash: true })
    await nextFrames(50)
    window.removeEventListener(FOCUS_TERMINAL_PANE_EVENT, listener)
    expect(reply.placement).toBe('grid')
    expect(activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(events).toEqual([{ tabId: 'term-target', leafId: LEAF, flashFocusedPane: true }])
  })

  it('never takes the keyboard from a composer holding unsent text', async () => {
    placement.placeBesideInWorkspace.mockReturnValue('split')
    const composer = document.createElement('textarea')
    const terminal = document.createElement('textarea')
    document.body.append(composer, terminal)
    composer.value = 'half a sentence'
    composer.focus()
    // A mounting pane that grabs focus anyway.
    activateTabAndFocusPane.mockImplementation(() => terminal.focus())
    const reply = showSidebarSession(target, { mode: 'beside', flash: true })
    expect(reply.keptKeyboardFocus).toBe(true)
    expect(activateTabAndFocusPane).toHaveBeenCalledWith('term-target', LEAF, {
      flashFocusedPane: true,
      keepKeyboardFocus: true
    })
    await nextFrames()
    expect(document.activeElement).toBe(composer)
  })

  it('--replace keeps the terminal focus path, with the flash', () => {
    const reply = showSidebarSession(target, { mode: 'replace', flash: true })
    expect(reply).toEqual({ placement: 'replaced', keptKeyboardFocus: false })
    expect(placement.placeBesideInWorkspace).not.toHaveBeenCalled()
    expect(focusTerminalFromHost).toHaveBeenCalledWith({
      tabId: 'term-target',
      worktreeId: 'wt-2',
      leafId: LEAF,
      flashFocusedPane: true
    })
  })

  it('--replace --no-flash is exactly the plain terminal focus', () => {
    showSidebarSession(target, { mode: 'replace', flash: false })
    expect(focusTerminalFromHost).toHaveBeenCalledWith({
      tabId: 'term-target',
      worktreeId: 'wt-2',
      leafId: LEAF
    })
  })

  it('pulses the sidebar row and scrolls it into view', async () => {
    placement.placeBesideInWorkspace.mockReturnValue('already-shown')
    const row = document.createElement('div')
    row.dataset.sessionKey = 'target'
    row.scrollIntoView = vi.fn()
    document.body.append(row)
    showSidebarSession(target, { mode: 'beside', flash: true })
    await nextFrames(50)
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(row.classList.contains('motion-safe:animate-pulse')).toBe(true)
  })
})
