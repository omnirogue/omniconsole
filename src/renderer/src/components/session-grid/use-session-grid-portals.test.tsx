/** @vitest-environment happy-dom */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setActivityTerminalPortals,
  useActivityTerminalPortals
} from '../activity/activity-terminal-portal'
import {
  useSessionGridTerminalPortals,
  type SessionGridTerminalSlot
} from './use-session-grid-portals'

vi.mock('../terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))

const slots: SessionGridTerminalSlot[] = ['first', 'second'].map((paneId) => ({
  paneId,
  target: document.createElement('div'),
  session: { worktreeId: 'workspace', tabId: paneId, kind: 'terminal' } as never
}))

afterEach(() => {
  setActivityTerminalPortals([], 'grid')
  setActivityTerminalPortals([], 'project')
})

describe('grid portal lifecycle', () => {
  it('unmounts only its owner while a project surface remains registered', () => {
    const grid = renderHook(() => useSessionGridTerminalPortals(slots, 'first', 'workspace'))
    const project = renderHook(() =>
      useSessionGridTerminalPortals([slots[1]], 'second', 'workspace', 'project')
    )
    const consumer = renderHook(() => useActivityTerminalPortals(true, true))
    expect(consumer.result.current).toHaveLength(3)
    grid.unmount()
    expect(consumer.result.current).toHaveLength(1)
    expect(consumer.result.current[0].tabId).toBe('second')
    project.unmount()
    expect(consumer.result.current).toEqual([])
  })

  it('keeps mounted panes behind maximize hidden and restores their visibility', () => {
    const publisher = renderHook(
      ({ maximized }: { maximized: string | null }) =>
        useSessionGridTerminalPortals(slots, 'second', 'workspace', 'grid', maximized),
      { initialProps: { maximized: null as string | null } }
    )
    const consumer = renderHook(() => useActivityTerminalPortals(true, true))
    expect(consumer.result.current.map((portal) => portal.visible)).toEqual([true, true])
    publisher.rerender({ maximized: 'first' })
    expect(consumer.result.current[1]).toMatchObject({
      mounted: true,
      visible: false,
      focused: false
    })
    publisher.rerender({ maximized: null })
    expect(consumer.result.current[1]).toMatchObject({
      mounted: true,
      visible: true,
      focused: true
    })
  })

  it('removes tray panes from the registry and registers them again on restore', () => {
    const publisher = renderHook(
      ({ shown }: { shown: SessionGridTerminalSlot[] }) =>
        useSessionGridTerminalPortals(shown, 'first', 'workspace'),
      { initialProps: { shown: slots } }
    )
    const consumer = renderHook(() => useActivityTerminalPortals(true, true))
    publisher.rerender({ shown: [slots[0]] })
    expect(consumer.result.current.map((portal) => portal.tabId)).toEqual(['first'])
    publisher.rerender({ shown: slots })
    expect(consumer.result.current[1]).toMatchObject({
      tabId: 'second',
      mounted: true,
      visible: true
    })
  })

  it('ignores pane visibility and maximize when the setting is off', () => {
    renderHook(() => useSessionGridTerminalPortals(slots, 'second', 'workspace', 'grid', 'first'))
    const consumer = renderHook(() => useActivityTerminalPortals(true))
    expect(consumer.result.current[1]).toMatchObject({ visible: true, active: true })
  })
})
