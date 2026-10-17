// @vitest-environment happy-dom
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PaneFocusContext } from '@/components/pane-focus-context'
import { useTaskPageKeyboardShortcuts } from './use-task-page-keyboard-shortcuts'

afterEach(cleanup)
function Tasks({ close, enabled = true }: { close: () => void; enabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  useTaskPageKeyboardShortcuts({
    searchEnabled: enabled,
    escapeEnabled: enabled,
    searchInputRef: input,
    closePage: close
  })
  return (
    <>
      <input aria-label="Search tasks" ref={input} />
      <input aria-label="Another editor" />
    </>
  )
}
const FOCUSED = { visible: true, focused: true }

const find = () =>
  fireEvent.keyDown(document.body, {
    key: 'f',
    ctrlKey: !navigator.userAgent.includes('Mac'),
    metaKey: navigator.userAgent.includes('Mac')
  })

it('keeps own-page search and Escape, including input and modal ownership', () => {
  const close = vi.fn()
  const { rerender } = render(<Tasks close={close} />)
  find()
  expect(document.activeElement).toBe(screen.getByLabelText('Search tasks'))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(document.body)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
  const other = screen.getByLabelText('Another editor')
  other.focus()
  fireEvent.keyDown(other, { key: 'f', ctrlKey: true, metaKey: true })
  expect(document.activeElement).toBe(other)
  rerender(<Tasks close={close} enabled={false} />)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
})

it.each([
  { visible: true, focused: false },
  { visible: false, focused: true }
])('leaves keys to the focused pane when %o', (focus) => {
  const close = vi.fn()
  const { rerender } = render(
    <PaneFocusContext.Provider value={focus}>
      <Tasks close={close} />
    </PaneFocusContext.Provider>
  )
  find()
  expect(document.activeElement).toBe(document.body)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  rerender(
    <PaneFocusContext.Provider value={FOCUSED}>
      <Tasks close={close} />
    </PaneFocusContext.Provider>
  )
  find()
  expect(document.activeElement).toBe(screen.getByLabelText('Search tasks'))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
})
