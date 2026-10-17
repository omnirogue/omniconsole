// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  PANE_HEADER_ACTION_GUTTER,
  usePaneHeaderActionGutter
} from './use-pane-header-action-gutter'

function HeaderLayout({ actions = true }: { actions?: boolean }) {
  const ref = usePaneHeaderActionGutter()
  return (
    <div>
      <div data-conversation-header-row="" />
      <div ref={ref}>{actions ? <div className="pane-title-actions" /> : null}</div>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reserves intersecting actions including the right inset, updates on resize and clears on removal', () => {
  let actionLeft = 160
  let actionTop = 0
  const resizes: (() => void)[] = []
  // Why synchronous frames: the hook coalesces observer callbacks into one measure per frame.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizes.push(callback)
      }
      observe() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('pane-title-actions')
        ? DOMRect.fromRect({ x: actionLeft, y: actionTop, width: 36, height: 24 })
        : DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 36 })
    }
  )
  const layout = (actions = true) => (
    <>
      <HeaderLayout actions={actions} />
      <HeaderLayout actions={false} />
    </>
  )
  const view = render(layout())
  const row = view.container.querySelector<HTMLElement>('[data-conversation-header-row]')!
  expect(row.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('40px')
  const sibling = view.container.querySelectorAll<HTMLElement>('[data-conversation-header-row]')[1]!
  expect(sibling.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('')
  actionLeft = 142
  act(() => resizes.forEach((resize) => resize()))
  expect(row.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('58px')
  actionTop = 100
  act(() => resizes.forEach((resize) => resize()))
  expect(row.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('')
  actionTop = 0
  act(() => resizes.forEach((resize) => resize()))
  view.rerender(layout(false))
  expect(row.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('')
  view.rerender(layout())
  expect(row.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('58px')
  view.unmount()
  expect(row.style.getPropertyValue(PANE_HEADER_ACTION_GUTTER)).toBe('')
})
