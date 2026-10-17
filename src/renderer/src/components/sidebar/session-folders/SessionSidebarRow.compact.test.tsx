// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { beginSessionSidebarDrag, clearSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SESSION_ROW_HOVER_CARD_DELAY_MS } from './SessionRowHoverCard'
import { SessionSidebarRow } from './SessionSidebarRow'
import { SessionRowHostBucketContext, useSessionRowHosts } from './use-session-row-host-label'

// These cover the hand composer itself, which ships behind a flag that is off.
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))

/**
 * Why these tests exist: Sal asked for one line per session so a hundred fit where fifteen did.
 * The row keeps its name and a 12 px glyph; the agent, the status line and every reason move
 * to the hover card, which opens on hover or focus after a pause and never over a drag or menu.
 */
vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

const session: SidebarSession = {
  rowKey: 'row-1',
  sessionKey: 'session-1',
  worktreeId: 'repo:/workspace',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: 'term:tab-1:pane-1',
  kind: 'terminal',
  label: 'Build landing page',
  workspaceLabel: 'Website',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

const FAILED_CHAIN = {
  chainId: 'chn_1',
  rowKey: session.rowKey,
  queued: 2,
  total: 3,
  state: 'failed' as const,
  auto: false,
  destination: { kind: 'me' as const },
  blocked: null,
  launchedPaneKeys: [],
  error: "The next session's agent exited before it started working (zsh is in the foreground)."
}

function renderRow(overrides: Partial<ComponentProps<typeof SessionSidebarRow>> = {}) {
  const props: ComponentProps<typeof SessionSidebarRow> = {
    session,
    current: false,
    queued: false,
    onOpen: vi.fn(),
    onCancelQueue: vi.fn(),
    ...overrides
  }
  render(
    <TooltipProvider>
      <SessionSidebarRow {...props} />
    </TooltipProvider>
  )
  return props
}

const openButton = () => screen.getByRole('button', { name: 'Open session Build landing page' })
const row = () => document.querySelector('[data-session-row]') as HTMLElement
const hoverCard = () => document.querySelector('[data-session-hover-card]')
const indicator = () => document.querySelector('[data-session-row-indicator]')

function hover(): void {
  fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' })
  act(() => {
    vi.advanceTimersByTime(SESSION_ROW_HOVER_CARD_DELAY_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(() => {
  cleanup()
  clearSessionSidebarDrag()
  vi.useRealTimers()
})

describe('one-line rows by default', () => {
  it('renders exactly the name on one line: no agent line, no status line, a 12 px glyph', () => {
    renderRow({ queued: true, chain: FAILED_CHAIN })
    expect(row().getAttribute('data-session-density')).toBe('compact')
    expect(document.querySelector('[data-session-agent-line]')).toBeNull()
    expect(document.querySelector('[data-session-status]')).toBeNull()
    expect(document.querySelector('[data-session-activity-row]')).toBeNull()
    expect(screen.queryByText('codex')).toBeNull()
    expect(screen.queryByText(/^Failed/)).toBeNull()
    const line = document.querySelectorAll('[data-session-row-line]')
    expect(line).toHaveLength(1)
    expect(line[0]!.textContent).toBe('Build landing page')
    expect(openButton().textContent).toBe('Build landing page')
    const glyph = document.querySelector('[data-conversation-state]')!
    expect(glyph.getAttribute('data-conversation-state-size')).toBe('sm')
    expect(glyph.className).toContain('size-3')
    expect(openButton().className.split(' ')).toContain('py-1')
    expect(openButton().className.split(' ')).not.toContain('py-2')
  })

  it('shows at most one mark at rest, by priority: needs you, running, snoozed, lock', () => {
    renderRow({ state: 'working' })
    expect(indicator()!.getAttribute('data-session-row-indicator')).toBe('running')
    expect(indicator()!.innerHTML).toContain('animate-pulse')
    expect(indicator()!.innerHTML).toContain('bg-status-success')
    cleanup()

    renderRow({ state: 'working', returned: true })
    expect(document.querySelectorAll('[data-session-row-indicator]')).toHaveLength(1)
    expect(indicator()!.getAttribute('data-session-row-indicator')).toBe('needs-you')
    expect(indicator()!.querySelector('.lucide-bell')).not.toBeNull()
    cleanup()

    renderRow({ state: 'monitoring' })
    expect(indicator()!.querySelector('.lucide-hourglass')).not.toBeNull()
    cleanup()

    renderRow({ waitingUntil: '2099-01-01T00:00:00.000Z' })
    expect(indicator()!.getAttribute('data-session-row-indicator')).toBe('snoozed')
    cleanup()

    renderRow({
      queued: true,
      chain: { ...FAILED_CHAIN, state: 'waiting', error: null, summary: 'Current → Claude' }
    })
    expect(indicator()!.getAttribute('data-session-row-indicator')).toBe('locked')
    cleanup()

    renderRow()
    expect(indicator()).toBeNull()
  })

  it('folds the actions to no width at rest, so the name keeps the row', () => {
    renderRow({ state: 'working' })
    const cluster = document.querySelector('[data-session-row-cluster]') as HTMLElement
    const actions = cluster.querySelector('[data-session-row-actions]') as HTMLElement
    // Why: invisible buttons used to keep ~185 of 255 px, leaving the name 0 px wide. Folded to
    // no width they stay in the DOM and focusable, and open on hover, focus or an open popover.
    const classes = actions.className.split(' ')
    expect(classes).toContain('can-hover:max-w-0')
    expect(classes).toContain('can-hover:overflow-clip')
    expect(classes).toContain('group-hover:max-w-none')
    expect(classes).toContain('focus-within:max-w-none')
    expect(classes).toContain('group-has-[button:focus-visible]:max-w-none')
    // A clicked row keeps focus on its Open button: that focus alone must not unfold them.
    expect(classes.filter((name) => name.startsWith('group-focus-within:'))).toEqual([])
    expect(classes).toContain('has-[[aria-haspopup][aria-expanded=true]]:max-w-none')
    expect(classes).toContain('has-[[data-pinned]]:max-w-none')
    expect(cluster.className.split(' ')).not.toContain('relative')
    expect(screen.getByRole('button', { name: 'Up next' })).toBeTruthy()
    // The resting mark sits in flow where the folded actions would be, and steps aside for them.
    const mark = indicator() as HTMLElement
    const markClasses = mark.className.split(' ')
    expect(markClasses).not.toContain('absolute')
    expect(markClasses).toContain('pointer-events-none')
    expect(markClasses).toContain('group-hover:hidden')
    expect(markClasses).toContain('group-has-[button:focus-visible]:hidden')
    expect(markClasses).toContain('group-has-[[data-session-row-actions]:focus-within]:hidden')
    expect(markClasses.filter((name) => name.startsWith('group-focus-within:'))).toEqual([])
    const before = cluster.innerHTML
    fireEvent.mouseOver(row())
    fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' })
    expect(cluster.innerHTML).toBe(before)
    // Folded, not removed: Tab still reaches them, and focus unfolds them.
    const hide = screen.getByRole('button', { name: 'Hide Build landing page' })
    hide.focus()
    expect(document.activeElement).toBe(hide)
  })

  it('keeps the ⋮ group open while its menu is up, wherever the pointer goes', () => {
    renderRow()
    const more = screen.getByRole('button', { name: 'More options' })
    expect(more.closest('[data-pinned]')).toBeNull()
    fireEvent.click(more)
    expect(more.closest('[data-pinned]')).toBeTruthy()
  })

  it('keeps a readable name while the controls show: the put-away group gives way, not the name', () => {
    renderRow()
    // Why: the controls on hover take about 185 of a 255 px row and squeezed the name to 0 px.
    const open = openButton().className.split(' ')
    expect(open).toContain(
      'min-w-[min(calc(var(--row-name-floor,8.5rem)_-_var(--row-name-give)),calc(100%_-_var(--row-name-reserve)_-_var(--row-name-give)))]'
    )
    expect(open).toContain('[--row-name-give:0rem]')
    expect(open).not.toContain('min-w-0')
    // Only a workflow row has the second glyph that raises the floor.
    expect(open).not.toContain('[--row-name-floor:9.625rem]')
    // The floor never pushes the fixed controls off the row: the chevron and a ready plan's ▶
    // reserve more, only on rows that have them.
    expect(open).toContain('[--row-name-reserve:5.125rem]')
    expect(open).toContain('group-has-[[data-session-row-expand]]:[--row-name-reserve:6.625rem]')
    expect(open).toContain('group-has-[[data-session-row-start]]:[--row-name-reserve:6.625rem]')
    expect(open).toContain(
      'group-has-[[data-session-row-start]]:group-has-[[data-session-row-expand]]:[--row-name-reserve:8.125rem]'
    )
    const cluster = document.querySelector('[data-session-row-cluster]') as HTMLElement
    expect(cluster.className.split(' ')).toContain('min-w-0')
    expect(cluster.className.split(' ')).not.toContain('shrink-0')
    const actions = cluster.querySelector('[data-session-row-actions]') as HTMLElement
    expect(actions.className.split(' ')).toContain('min-w-0')
    // What does not fit folds away whole, from the end: Tags, then Archive, then Hide.
    const group = cluster.querySelector('[data-session-row-yield]') as HTMLElement
    expect([...group.children].map((child) => child.getAttribute('aria-label'))).toEqual([
      'Hide Build landing page',
      'Archive Build landing page',
      'Tags'
    ])
    // Why an icon: labelled, Tags was the widest control and never fit beside the name's floor.
    const tags = screen.getByRole('button', { name: 'Tags' })
    expect(tags.textContent).toBe('')
    expect(tags.className.split(' ')).toContain('size-6')
    const classes = group.className.split(' ')
    for (const name of ['min-w-0', 'flex-wrap', 'h-6', 'overflow-clip', 'before:h-6']) {
      expect(classes).toContain(name)
    }
    // Still hover-only, and still opened by focus or an open popover.
    expect(classes).toContain('can-hover:max-w-0')
    expect(classes).toContain('group-hover:max-w-none')
    expect(classes).toContain('focus-within:max-w-none')
    expect(classes).toContain('has-[[aria-haspopup][aria-expanded=true]]:max-w-none')
    // Why never overflow-visible on hover: the wrapped line would draw over the row below.
    expect(classes).not.toContain('group-hover:overflow-visible')
  })

  it('makes room for a keyboard-focused put-away control by its place, not by dropping the name', () => {
    renderRow()
    const open = openButton().className.split(' ')
    // Why: dropping the floor for any focus in the group let the name all but vanish even when
    // the focused control already fitted. Each place asks for 1.5rem more, and no more.
    expect(open).toContain(
      'group-has-[[data-session-row-yield]>:nth-child(1):focus-visible]:[--row-name-give:1.5rem]'
    )
    expect(open).toContain(
      'group-has-[[data-session-row-yield]>:nth-child(2):focus-visible]:[--row-name-give:3rem]'
    )
    expect(open).toContain(
      'group-has-[[data-session-row-yield]>:nth-child(3):focus-visible]:[--row-name-give:4.5rem]'
    )
    expect(open.filter((name) => name.endsWith(':min-w-0'))).toEqual([])
    // Why never unwrapped for focus: the controls after the focused one would draw over the name.
    const group = document.querySelector('[data-session-row-yield]') as HTMLElement
    expect(
      group.className.split(' ').filter((name) => name.includes('focus-visible]:flex'))
    ).toEqual([])
  })

  it('keeps the Tags anchor where it was while its popover is up', () => {
    renderRow()
    const tags = screen.getByRole('button', { name: 'Tags' })
    const group = document.querySelector('[data-session-row-yield]') as HTMLElement
    fireEvent.click(tags)
    expect(tags.getAttribute('aria-expanded')).toBe('true')
    // Focus goes into the popover: the name keeps giving Tags its room, and Tags keeps its line.
    expect(tags.parentElement).toBe(group)
    expect(openButton().className.split(' ')).toContain(
      'group-has-[[data-session-row-yield]>[aria-expanded=true]]:[--row-name-give:4.5rem]'
    )
    const classes = group.className.split(' ')
    expect(classes).toContain('has-[[aria-haspopup][aria-expanded=true]]:flex-nowrap')
    expect(classes).toContain('has-[[aria-haspopup][aria-expanded=true]]:overflow-visible')
    // Why: the ⋮ ＋ beside it folded once the pointer left the row, sliding Tags 3.5rem right.
    const more = screen.getByRole('button', { name: 'More options' })
    const beside = more.parentElement!.closest('[class*="can-hover:max-w-0"]') as HTMLElement
    expect(beside.className.split(' ')).toContain(
      'group-has-[[aria-haspopup][aria-expanded=true]]:max-w-none'
    )
    expect(beside.className.split(' ')).toContain(
      'group-has-[[aria-haspopup][aria-expanded=true]]:opacity-100'
    )
  })

  it('keeps the checkbox on the same single line', () => {
    renderRow({ onSelect: () => false })
    expect(screen.getByRole('checkbox', { name: 'Select Build landing page' })).toBeTruthy()
    expect(document.querySelectorAll('[data-session-row-line]')).toHaveLength(1)
  })
})

describe('details on hover', () => {
  it('opens the card after the pause with the agent, the status line and the full reason', () => {
    renderRow({ queued: true, chain: FAILED_CHAIN })
    fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' })
    act(() => {
      vi.advanceTimersByTime(SESSION_ROW_HOVER_CARD_DELAY_MS - 1)
    })
    expect(hoverCard()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    const card = hoverCard() as HTMLElement
    expect(card.textContent).toContain('codex')
    const status = card.querySelector('[data-session-status]') as HTMLElement
    expect(status.getAttribute('data-session-status')).toBe('failed')
    expect(status.textContent).toMatch(/^Failed · The next agent could not begin work/)
    // Why: in the card the line wraps; the list is where it clips.
    expect(status.querySelector('.truncate')).toBeNull()
    expect(status.querySelector('.whitespace-normal')).toBeTruthy()
    const details = card.querySelector('[data-session-row-details="card"]') as HTMLElement
    expect(details.querySelector('[data-session-failure]')!.textContent).toMatch(
      /could not begin work\. Check the selected agent/
    )
    expect(details.className).not.toContain('border-l')
    // The list still shows one line.
    expect(row().querySelector('[data-session-status]')).toBeNull()
  })

  it('opens the card from keyboard focus too', () => {
    renderRow({ returned: true })
    act(() => {
      openButton().focus()
    })
    expect(hoverCard()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(SESSION_ROW_HOVER_CARD_DELAY_MS)
    })
    expect(hoverCard()!.textContent).toContain('Back to you · results ready')
  })

  it('never opens while a row is being dragged', () => {
    renderRow()
    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'x', workspaceGroupKey: 'w' })
    hover()
    expect(hoverCard()).toBeNull()
  })

  it('never opens while a menu from the row is open', () => {
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    hover()
    expect(hoverCard()).toBeNull()
  })

  it('keeps the chevron as the inline path to the same details', () => {
    renderRow({ queued: true, chain: FAILED_CHAIN })
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Build landing page' }))
    const inline = document.querySelector('[data-session-row-details="inline"]') as HTMLElement
    expect(inline.textContent).toMatch(/could not begin work/)
    expect(useSessionSidebarView.getState().view.expandedRows).toEqual(['session-1'])
  })
})

describe('comfortable density', () => {
  it('restores the agent and status lines on the row', () => {
    useSessionSidebarView.getState().setDensity('comfortable')
    renderRow({ queued: true, chain: FAILED_CHAIN })
    expect(row().getAttribute('data-session-density')).toBe('comfortable')
    expect(document.querySelector('[data-session-agent-line]')!.textContent).toBe('codex')
    expect(document.querySelector('[data-session-status]')!.textContent).toMatch(/^Failed/)
    expect(indicator()).toBeNull()
    expect(
      document
        .querySelector('[data-conversation-state-size]')!
        .getAttribute('data-conversation-state-size')
    ).toBe('md')
    expect(openButton().className.split(' ')).toContain('py-2')
  })
})

/**
 * Why these tests exist: Sal saw the Mac Studio list sessions from both Macs without saying
 * which computer each ran on. A row names its computer once the list mixes computers.
 */
describe('the computer a row runs on', () => {
  const STUDIO_ID = '7f3c2a9e-1b4d-4c6e-9a8f-2d5b6c7e8f90'
  const onStudio: SidebarSession = { ...session, hostId: `runtime:${STUDIO_ID}` }
  const environmentsBefore = useAppStore.getState().runtimeEnvironments
  const label = () => document.querySelector('[data-session-host-label]')

  beforeEach(() => {
    useAppStore.setState({ runtimeEnvironments: [{ id: STUDIO_ID, name: 'Mac Studio' }] as never })
    useSessionRowHosts.setState({ shown: true })
  })

  afterEach(() => {
    useAppStore.setState({ runtimeEnvironments: environmentsBefore })
    useSessionRowHosts.setState({ shown: false })
  })

  it('names it after the title on the same single line', () => {
    renderRow({ session: onStudio })
    const lines = document.querySelectorAll('[data-session-row-line]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.contains(label())).toBe(true)
    expect(label()!.textContent).toBe('Mac Studio')
    expect(label()!.getAttribute('title')).toBe('On Mac Studio')
    expect(label()!.className).toContain('truncate')
    expect(label()!.textContent).not.toContain(STUDIO_ID)
    expect(
      screen.getByRole('button', { name: 'Open session Build landing page on Mac Studio' })
    ).toBeTruthy()
  })

  it('says This computer for a local row in a mixed list', () => {
    renderRow()
    expect(label()!.textContent).toBe('This computer')
  })

  it('names nothing while the list shows one computer', () => {
    useSessionRowHosts.setState({ shown: false })
    renderRow({ session: onStudio })
    expect(label()).toBeNull()
    expect(openButton().textContent).toBe('Build landing page')
  })

  it("names nothing inside the computer's own bucket, and names a stranger there", () => {
    render(
      <TooltipProvider>
        <SessionRowHostBucketContext.Provider value={onStudio.hostId}>
          <SessionSidebarRow
            session={onStudio}
            current={false}
            queued={false}
            onOpen={vi.fn()}
            onCancelQueue={vi.fn()}
          />
        </SessionRowHostBucketContext.Provider>
      </TooltipProvider>
    )
    expect(label()).toBeNull()
    cleanup()

    render(
      <TooltipProvider>
        <SessionRowHostBucketContext.Provider value="local">
          <SessionSidebarRow
            session={onStudio}
            current={false}
            queued={false}
            onOpen={vi.fn()}
            onCancelQueue={vi.fn()}
          />
        </SessionRowHostBucketContext.Provider>
      </TooltipProvider>
    )
    expect(label()!.textContent).toBe('Mac Studio')
  })
})
