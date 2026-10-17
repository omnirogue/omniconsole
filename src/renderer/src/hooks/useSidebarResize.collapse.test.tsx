// @vitest-environment happy-dom
import { render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSidebarResize } from './useSidebarResize'
afterEach(cleanup)

function Panel({
  sign,
  collapse,
  save
}: {
  sign: 1 | -1
  collapse: () => void
  save: (width: number) => void
}) {
  const resize = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: 300,
    minWidth: 220,
    maxWidth: 500,
    deltaSign: sign,
    setWidth: save,
    onCollapse: collapse
  })
  return (
    <div ref={resize.containerRef}>
      <button onMouseDown={resize.onResizeStart}>Resize</button>
    </div>
  )
}

describe('dragging sidebars closed', () => {
  it.each([1, -1] as const)('collapses side %s without replacing its saved width', (sign) => {
    const collapse = vi.fn(),
      save = vi.fn()
    const { getByRole } = render(<Panel sign={sign} collapse={collapse} save={save} />)
    fireEvent.mouseDown(getByRole('button'), { clientX: 500, button: 0 })
    fireEvent.mouseMove(window, { clientX: 500 - sign * 260 })
    fireEvent.mouseUp(window)
    expect(collapse).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    expect(document.body.style.cursor).toBe('')
  })
  it('snaps back to minimum above the collapse threshold', () => {
    const collapse = vi.fn(),
      save = vi.fn()
    const { getByRole } = render(<Panel sign={1} collapse={collapse} save={save} />)
    fireEvent.mouseDown(getByRole('button'), { clientX: 500, button: 0 })
    fireEvent.mouseMove(window, { clientX: 350 })
    fireEvent.mouseUp(window)
    expect(collapse).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith(220)
  })
})
