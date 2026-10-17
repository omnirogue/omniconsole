// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  beginSessionSidebarDrag,
  clearSessionSidebarDrag,
  SESSION_ROW_DRAG_TYPE
} from '@/lib/session-sidebar-drag'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  seed: vi.fn(),
  toast: { error: vi.fn() }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('./conversation-routine-seed', () => ({ conversationRoutineSeed: mocks.seed }))
import { RoutineDropTarget } from './RoutineDropTarget'

function transfer(value: string) {
  return {
    types: [SESSION_ROW_DRAG_TYPE],
    dropEffect: 'none',
    getData: (type: string) => (type === SESSION_ROW_DRAG_TYPE ? value : ''),
    setData: vi.fn()
  }
}

function fire(type: 'dragOver' | 'drop', element: Element, dataTransfer: unknown): Event {
  const event = createEvent[type](element, { dataTransfer })
  fireEvent(element, event)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  clearSessionSidebarDrag()
  mocks.state = {
    setPendingRoutineDraftSeed: vi.fn(),
    setSidebarSessionSurface: vi.fn(),
    setActiveView: vi.fn()
  }
  mocks.seed.mockReturnValue({ cron: '0 9 * * *', name: 'Chat' })
})
afterEach(cleanup)

it('seeds a routine from a dragged conversation', () => {
  render(
    <RoutineDropTarget>
      <span>Routines</span>
    </RoutineDropTarget>
  )
  const target = screen.getByText('Routines').parentElement!
  beginSessionSidebarDrag({ kind: 'row', sessionKey: 'session-1', workspaceGroupKey: '' })
  expect(fire('dragOver', target, transfer('session-1')).defaultPrevented).toBe(true)
  expect(target.getAttribute('data-drag-over')).toBe('true')
  fire('drop', target, transfer('session-1'))
  expect(mocks.seed).toHaveBeenCalledWith(mocks.state, 'session-1')
  expect(mocks.state.setPendingRoutineDraftSeed).toHaveBeenCalledWith({
    cron: '0 9 * * *',
    name: 'Chat'
  })
  expect(mocks.state.setActiveView).toHaveBeenCalledWith('automations')
})

it('ignores a routine row dragged within its own list', () => {
  render(
    <RoutineDropTarget>
      <span>Routines</span>
    </RoutineDropTarget>
  )
  const target = screen.getByText('Routines').parentElement!
  beginSessionSidebarDrag({
    kind: 'row',
    sessionKey: 'routine:local:a',
    workspaceGroupKey: 'workspace:other'
  })
  expect(fire('dragOver', target, transfer('routine:local:a')).defaultPrevented).toBe(false)
  expect(target.getAttribute('data-drag-over')).toBe('false')
  // Why: the drop itself is refused too, even when the in-flight record was cleared early.
  clearSessionSidebarDrag()
  fire('drop', target, transfer('routine:local:a'))
  expect(mocks.seed).not.toHaveBeenCalled()
  expect(mocks.state.setPendingRoutineDraftSeed).not.toHaveBeenCalled()
  expect(mocks.toast.error).not.toHaveBeenCalled()
})
