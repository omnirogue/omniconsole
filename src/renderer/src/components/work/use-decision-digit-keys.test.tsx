// @vitest-environment happy-dom
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PaneFocusContext } from '@/components/pane-focus-context'
import { useDecisionDigitKeys } from './use-decision-digit-keys'

const FOCUSED = { visible: true, focused: true }
const UNFOCUSED = { visible: true, focused: false }
const HIDDEN = { visible: false, focused: true }

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function Decisions({ answer }: { answer: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useDecisionDigitKeys(box)
  return (
    <div ref={box}>
      <button aria-pressed="false" onClick={answer}>
        Yes
      </button>
      <input aria-label="Message" />
    </div>
  )
}
it('keeps full-page digits and does not answer while typing or using modifiers', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  const answer = vi.fn()
  render(<Decisions answer={answer} />)
  fireEvent.keyDown(document.body, { key: '1' })
  expect(answer).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(screen.getByLabelText('Message'), { key: '1' })
  fireEvent.keyDown(document.body, { key: '1', ctrlKey: true })
  expect(answer).toHaveBeenCalledTimes(1)
})
it('only the visible focused decision pane answers, including after focus changes', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  const first = vi.fn(),
    second = vi.fn()
  const panes = (focused: boolean) => (
    <>
      <PaneFocusContext.Provider value={focused ? FOCUSED : UNFOCUSED}>
        <Decisions answer={first} />
      </PaneFocusContext.Provider>
      <PaneFocusContext.Provider value={focused ? UNFOCUSED : FOCUSED}>
        <Decisions answer={second} />
      </PaneFocusContext.Provider>
    </>
  )
  const { rerender } = render(panes(true))
  fireEvent.keyDown(document.body, { key: '1' })
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).not.toHaveBeenCalled()
  rerender(panes(false))
  fireEvent.keyDown(document.body, { key: '1' })
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  rerender(
    <PaneFocusContext.Provider value={HIDDEN}>
      <Decisions answer={first} />
    </PaneFocusContext.Provider>
  )
  fireEvent.keyDown(document.body, { key: '1' })
  expect(first).toHaveBeenCalledTimes(1)
})
