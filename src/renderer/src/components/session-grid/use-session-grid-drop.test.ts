/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionGridDropTargetAt } from './use-session-grid-drop'

vi.mock('@/lib/session-grid-actions', () => ({
  captureSessionGridDrag: vi.fn(),
  dropOnSessionGrid: vi.fn()
}))
afterEach(() => document.body.replaceChildren())

describe('maximized grid drop routing', () => {
  it('skips hidden panes that overlap the maximized pane', () => {
    const body = document.createElement('div')
    body.innerHTML =
      '<div inert><section data-session-grid-pane="hidden"></section></div><section data-session-grid-pane="shown"></section>'
    document.body.append(body)
    const rect = new DOMRect(0, 0, 100, 100)
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect)
    for (const pane of body.querySelectorAll('section')) {
      vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(rect)
    }
    expect(sessionGridDropTargetAt(body, { x: 50, y: 50 })).toMatchObject({
      paneId: 'shown',
      zone: 'center'
    })
    body.firstElementChild!.removeAttribute('inert')
    expect(sessionGridDropTargetAt(body, { x: 50, y: 50 })).toMatchObject({
      paneId: 'hidden',
      zone: 'center'
    })
  })
})
