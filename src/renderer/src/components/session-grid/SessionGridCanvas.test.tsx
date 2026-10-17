/** @vitest-environment happy-dom */
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionGridCanvas } from './SessionGridCanvas'
import { SessionGridPaneFrame } from './SessionGridPaneFrame'
import { moveSessionGridPane, type SessionGridLayout } from '@/lib/session-grid-layout'

vi.mock('./use-session-grid-drop', () => ({ useSessionGridDrop: () => ({ active: false }) }))
const layout: SessionGridLayout = {
  orientation: 'columns',
  tracks: [['a'], ['b']],
  trackSizes: [0.65, 0.35],
  paneSizes: [[1], [1]]
}
afterEach(cleanup)

describe('command-center pane mount continuity', () => {
  it('retains pane bodies through swap, orientation, maximize and restore', () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function Body({ id }: { id: string }): React.JSX.Element {
      useEffect(() => {
        mounted(id)
        return () => unmounted(id)
      }, [id])
      return <span data-body={id}>{id}</span>
    }
    const onResize = vi.fn()
    const pane = (id: string): React.ReactNode => <Body id={id} />
    const view = render(
      <SessionGridCanvas
        layout={layout}
        renderPane={pane}
        onResize={onResize}
        empty={null}
        maximizedPaneId={null}
      />
    )
    const first = view.container.querySelector('[data-body="a"]')
    const second = view.container.querySelector('[data-body="b"]')
    const swapped = moveSessionGridPane(layout, 'a', { paneId: 'b', zone: 'center' })
    view.rerender(
      <SessionGridCanvas
        layout={swapped}
        renderPane={pane}
        onResize={onResize}
        empty={null}
        maximizedPaneId="a"
      />
    )
    expect(view.container.querySelector('[data-body="a"]')).toBe(first)
    expect(view.container.querySelector('[data-body="b"]')).toBe(second)
    expect(second?.parentElement?.style.visibility).toBe('hidden')
    expect(view.container.querySelectorAll('[role="separator"]')).toHaveLength(0)
    view.rerender(
      <SessionGridCanvas
        layout={{ ...swapped, orientation: 'rows' }}
        renderPane={pane}
        onResize={onResize}
        empty={null}
        maximizedPaneId={null}
      />
    )
    expect(view.container.querySelector('[data-body="b"]')).toBe(second)
    expect(second?.parentElement?.style.visibility).toBe('')
    expect(mounted.mock.calls.flat().sort()).toEqual(['a', 'b'])
    expect(unmounted).not.toHaveBeenCalled()
    expect(onResize).not.toHaveBeenCalled()
  })
  it('provides button/header restore and lets Escape reach the terminal', () => {
    const toggle = vi.fn()
    const view = render(
      <SessionGridPaneFrame
        pane={{ kind: 'notepad', noteId: 'n', id: 'p' }}
        label="Note"
        focused
        onFocus={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        maximized
        onToggleMaximize={toggle}
      >
        <div tabIndex={0} data-terminal="" />
      </SessionGridPaneFrame>
    )
    const terminal = view.container.querySelector('[data-terminal]')!
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      terminal.dispatchEvent(escape)
    })
    expect(escape.defaultPrevented).toBe(false)
    expect(toggle).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Restore pane size' }))
    expect(toggle).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(view.container.querySelector('header')!)
    expect(toggle).toHaveBeenCalledTimes(2)
  })
  it('keeps legacy chrome unchanged without the setting controls', () => {
    const view = render(
      <SessionGridPaneFrame
        pane={{ kind: 'notepad', noteId: 'n', id: 'p' }}
        label="Note"
        focused={false}
        onFocus={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
      >
        <span>note</span>
      </SessionGridPaneFrame>
    )
    expect(view.queryByRole('button', { name: 'Choose pane content' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Maximize pane' })).toBeNull()
  })
})
