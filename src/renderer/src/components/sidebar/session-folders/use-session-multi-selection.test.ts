// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionMultiSelection } from './use-session-multi-selection'

describe('shared session selection across views', () => {
  const visible = ['first', 'second', 'third']
  const ref = { current: null }
  beforeEach(() =>
    useSessionSelection.setState({
      keys: [],
      anchor: null,
      focus: null,
      explicit: false,
      scope: 'all'
    })
  )
  afterEach(cleanup)

  it('retains a checkbox selection across a view remount and extends it with Shift-click', () => {
    const first = renderHook(() => useSessionMultiSelection(visible, ref))
    act(() => useSessionSelection.getState().toggle('first', 'visible'))
    expect(first.result.current.bulk).toBe(true)
    first.unmount()
    const second = renderHook(() => useSessionMultiSelection(visible, ref))
    expect([...second.result.current.selectedKeys]).toEqual(['first'])
    act(() =>
      second.result.current.select({ metaKey: false, ctrlKey: false, shiftKey: true }, 'third')
    )
    expect(useSessionSelection.getState().keys).toEqual(visible)
    act(() => second.result.current.clear())
    expect(useSessionSelection.getState().keys).toEqual([])
  })

  it('keeps explicitly all-session picker selection while a filtered list is mounted', () => {
    useSessionSelection.getState().set(visible)
    const hook = renderHook(() => useSessionMultiSelection(['first'], ref))
    expect(useSessionSelection.getState().keys).toEqual(visible)
    expect(hook.result.current.bulk).toBe(false)
  })

  it('removes filtered-out rows from the shared selection before bulk actions', () => {
    useSessionSelection
      .getState()
      .setGesture({ selected: new Set(visible), anchor: 'first', focus: 'third' }, true)
    const shown = ['first', 'third']
    const hook = renderHook(() => useSessionMultiSelection(shown, ref))
    expect([...hook.result.current.selectedKeys]).toEqual(shown)
    expect(useSessionSelection.getState().keys).toEqual(shown)
  })
})
