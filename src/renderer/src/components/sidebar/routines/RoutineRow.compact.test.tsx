// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { beginSessionSidebarDrag, clearSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { Automation } from '../../../../../shared/automations-types'
import { SESSION_ROW_HOVER_CARD_DELAY_MS } from '../session-folders/SessionRowHoverCard'
import { SessionRowDensityToggle } from '../session-folders/SessionRowDensityToggle'
import { RoutineRow } from './RoutineRow'
import type { RoutineCommands } from './routine-row-commands'

/**
 * Why these tests exist: Sal asked for the Conversations one-line rows on Routines too. A routine
 * row keeps its name and a 12 px glyph; the schedule, next run, "Paused" and "Archived" lines move
 * to a hover card that opens on hover or focus after the shared pause, never over a drag or menu.
 * One density preference rules both tabs.
 */
const mocks = vi.hoisted(() => ({ runs: vi.fn() }))
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: mocks.runs
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) })
}))
// Why: #429 put the share popover in the row actions; its people read needs the real
// store, and this file tests the row, not sharing.
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({ data: null, loading: false, error: null, reload: () => {} })
}))

const HOUR = 60 * 60 * 1000

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a',
    name: 'Campaign review',
    prompt: 'Check conversions',
    rrule: '*/30 * * * 1-5',
    enabled: true,
    nextRunAt: Date.now() + 2 * HOUR,
    lastRunAt: Date.now() - 3 * HOUR,
    ...overrides
  } as Automation
}

const commands: RoutineCommands = {
  target: { kind: 'local' },
  update: vi.fn(),
  setEnabled: vi.fn(),
  rename: vi.fn(),
  runNow: vi.fn(),
  remove: vi.fn()
}

function renderRow(overrides: Partial<ComponentProps<typeof RoutineRow>> = {}) {
  render(
    <TooltipProvider>
      <RoutineRow
        automation={automation()}
        routineKey="routine:local:a"
        current={false}
        opening={false}
        hidden={false}
        archived={false}
        folders={[]}
        folderId={null}
        commands={commands}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  )
}

const openButton = () => screen.getByRole('button', { name: 'Open routine Campaign review' })
const row = () => document.querySelector('[data-routine-row]') as HTMLElement
const hoverCard = () => document.querySelector('[data-routine-hover-card]') as HTMLElement | null
const indicator = () => document.querySelector('[data-routine-row-indicator]') as HTMLElement | null
const detail = (kind: string) =>
  document.querySelector(`[data-routine-hover-detail="${kind}"] dd`) as HTMLElement | null

function hover(): void {
  // Why not by role: an open dropdown hides the rest of the page from the accessibility tree.
  const trigger = document.querySelector('[data-routine-open]') as HTMLElement
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  act(() => {
    vi.advanceTimersByTime(SESSION_ROW_HOVER_CARD_DELAY_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.runs.mockResolvedValue([])
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
})

afterEach(() => {
  cleanup()
  clearSessionSidebarDrag()
  vi.useRealTimers()
})

describe('one-line rows by default', () => {
  it('renders exactly the name on one line with a 12 px glyph: no schedule or paused lines', () => {
    renderRow({ automation: automation({ enabled: false }), archived: true })
    expect(row().getAttribute('data-routine-density')).toBe('compact')
    expect(document.querySelectorAll('[data-routine-row-line]')).toHaveLength(1)
    expect(document.querySelector('[data-routine-caption]')).toBeNull()
    expect(document.querySelector('[data-routine-archived]')).toBeNull()
    expect(openButton().textContent).toBe('Campaign review')
    expect(screen.queryByText(/Every 30 min/)).toBeNull()
    const glyph = row().querySelector('[data-routine-state]')!
    expect(glyph.getAttribute('data-routine-state')).toBe('paused')
    expect(glyph.getAttribute('data-routine-state-size')).toBe('sm')
    expect(glyph.className).toContain('size-3')
    expect(openButton().className.split(' ')).toContain('py-1')
    expect(openButton().className.split(' ')).not.toContain('py-2')
  })

  it('shows at most one mark at rest, by priority: due now, then paused, else nothing', () => {
    renderRow({ automation: automation({ nextRunAt: Date.now() - 1000 }) })
    expect(indicator()!.getAttribute('data-routine-row-indicator')).toBe('due')
    expect(indicator()!.getAttribute('aria-label')).toBe('Due now')
    expect(row().querySelector('[data-routine-state]')!.getAttribute('data-routine-state')).toBe(
      'due'
    )
    cleanup()

    renderRow({ automation: automation({ enabled: false, nextRunAt: Date.now() - 1000 }) })
    expect(document.querySelectorAll('[data-routine-row-indicator]')).toHaveLength(1)
    expect(indicator()!.getAttribute('data-routine-row-indicator')).toBe('paused')
    // The paused mark keeps the word and the attribute the comfortable row prints.
    expect(indicator()!.hasAttribute('data-routine-paused')).toBe(true)
    expect(indicator()!.textContent).toBe('Paused')
    expect(document.querySelectorAll('[data-routine-paused]')).toHaveLength(1)
    cleanup()

    renderRow()
    expect(indicator()).toBeNull()
    expect(document.querySelector('[data-routine-paused]')).toBeNull()
  })

  it('reserves the action cluster width: hovering swaps mark for buttons without a DOM change', () => {
    renderRow({ automation: automation({ enabled: false }) })
    const cluster = document.querySelector('[data-routine-row-cluster]') as HTMLElement
    const actions = cluster.querySelector('[data-routine-row-actions]') as HTMLElement
    expect(cluster.className.split(' ')).toContain('relative')
    expect(actions.className.split(' ')).toContain('opacity-0')
    expect(actions.className).toContain('group-hover:opacity-100')
    expect(actions.className).not.toContain('hidden')
    expect(screen.getByRole('button', { name: 'Resume Campaign review' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Schedule for Campaign review' })).toBeTruthy()
    const mark = indicator() as HTMLElement
    expect(mark.className.split(' ')).toContain('absolute')
    expect(mark.className.split(' ')).toContain('pointer-events-none')
    expect(mark.className).toContain('group-hover:opacity-0')
    const before = cluster.innerHTML
    fireEvent.mouseOver(row())
    fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' })
    expect(cluster.innerHTML).toBe(before)
  })
})

describe('details on hover', () => {
  it('opens the card after the pause with the schedule, window, next run and last run', async () => {
    const now = Date.now()
    mocks.runs.mockResolvedValue([
      {
        id: 'r1',
        automationId: 'a',
        status: 'completed',
        createdAt: now - 3 * HOUR,
        dispatchedAt: now - 3 * HOUR,
        startedAt: null
      }
    ])
    renderRow()
    fireEvent.pointerEnter(openButton(), { pointerType: 'mouse' })
    act(() => {
      vi.advanceTimersByTime(SESSION_ROW_HOVER_CARD_DELAY_MS - 1)
    })
    expect(hoverCard()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    const card = hoverCard()!
    expect(card.textContent).toContain('Campaign review')
    expect(card.querySelector('[data-routine-hover-caption]')!.textContent).toBe(
      'Every 30 min · Mon–Fri · Next in 2 hours'
    )
    expect(detail('window')!.textContent).toBe('Every 30 min · Mon–Fri')
    expect(detail('next-run')!.textContent).toBe('in 2 hours')
    expect(detail('next-run')!.getAttribute('title')).toMatch(/\d/)
    // Why: the run history is read only once the card is up; until it answers, lastRunAt alone.
    expect(mocks.runs).toHaveBeenCalledWith({ kind: 'local' }, 'a')
    expect(detail('last-run')!.textContent).toBe('3h ago')
    await act(async () => {
      await Promise.resolve()
    })
    expect(detail('last-run')!.textContent).toBe('Done 3h ago')
    // The list still shows one line.
    expect(row().querySelector('[data-routine-caption]')).toBeNull()
  })

  it('explains a paused, archived routine in the card', () => {
    renderRow({ automation: automation({ enabled: false }), archived: true })
    hover()
    const card = hoverCard()!
    expect(card.querySelector('[data-routine-hover-caption]')!.textContent).toBe(
      'Every 30 min · Mon–Fri · Paused'
    )
    expect(detail('next-run')).toBeNull()
    expect(card.querySelector('[data-routine-hover-paused]')!.textContent).toBe(
      'Archived and paused'
    )
  })

  it('opens the card from keyboard focus too', () => {
    renderRow()
    act(() => {
      openButton().focus()
    })
    expect(hoverCard()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(SESSION_ROW_HOVER_CARD_DELAY_MS)
    })
    expect(hoverCard()!.textContent).toContain('Every 30 min')
  })

  it('never opens while a row is being dragged', () => {
    renderRow()
    beginSessionSidebarDrag({ kind: 'row', sessionKey: 'x', workspaceGroupKey: 'w' })
    hover()
    expect(hoverCard()).toBeNull()
  })

  it('never opens while a menu from the row is open', () => {
    renderRow()
    // Why pointerdown: a Radix dropdown opens on the press, before any click lands.
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'More options for Campaign review' }),
      {
        button: 0,
        pointerType: 'mouse'
      }
    )
    expect(screen.getByRole('menu')).toBeTruthy()
    hover()
    expect(hoverCard()).toBeNull()
  })

  it('keeps the schedule read-only in the card: no run fetch while the card is shut', () => {
    renderRow()
    expect(mocks.runs).not.toHaveBeenCalled()
  })
})

describe('comfortable density', () => {
  it('restores the schedule, next run, archived and paused lines on the row', () => {
    useSessionSidebarView.getState().setDensity('comfortable')
    renderRow({ automation: automation({ enabled: false }), archived: true })
    expect(row().getAttribute('data-routine-density')).toBe('comfortable')
    const captions = [...document.querySelectorAll('[data-routine-caption]')].map(
      (line) => line.textContent
    )
    expect(captions).toEqual(['Every 30 min · Mon–Fri · Paused'])
    expect(document.querySelector('[data-routine-archived]')!.textContent).toBe('Archived')
    const paused = document.querySelector('[data-routine-paused]') as HTMLElement
    expect(paused.textContent).toBe('Paused')
    expect(paused.hasAttribute('data-routine-row-indicator')).toBe(false)
    expect(indicator()).toBeNull()
    expect(
      row().querySelector('[data-routine-state]')!.getAttribute('data-routine-state-size')
    ).toBe('md')
    expect(openButton().className.split(' ')).toContain('py-2')
  })

  it('follows the one Compact rows toggle shared with Conversations', () => {
    useSessionSidebarView.getState().setDensity('comfortable')
    render(<SessionRowDensityToggle />)
    renderRow()
    expect(row().getAttribute('data-routine-density')).toBe('comfortable')
    expect(document.querySelectorAll('[data-routine-caption]').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Compact rows' }))
    expect(useSessionSidebarView.getState().view.density).toBe('compact')
    expect(row().getAttribute('data-routine-density')).toBe('compact')
    expect(document.querySelector('[data-routine-caption]')).toBeNull()
    expect(document.querySelectorAll('[data-routine-row-line]')).toHaveLength(1)
  })
})
