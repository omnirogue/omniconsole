// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { hasVisibleOverlay } from './visible-overlay'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string): void {
  document.body.innerHTML = html
}

describe('hasVisibleOverlay', () => {
  it('is false with no overlay on screen', () => {
    mount('<div>page chrome</div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it.each(['dialog', 'alertdialog', 'listbox', 'menu'])('sees a visible %s', (role) => {
    mount(`<div role="${role}"></div>`)

    expect(hasVisibleOverlay()).toBe(true)
  })

  it('ignores the always-mounted sidebar lists', () => {
    // Why: the workspace and conversation lists are app chrome with role="listbox". Counting
    // them made every page think a popup owned Escape, so Escape stopped closing the page.
    mount('<div role="listbox" data-sidebar-persistent-list></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('still sees a real popup rendered inside a sidebar list', () => {
    // :not() matches the element, never its subtree — a combobox listbox or menu opened from
    // a sidebar row is a genuine overlay and still owns the first Escape.
    mount('<div role="listbox" data-sidebar-persistent-list><div role="menu"></div></div>')

    expect(hasVisibleOverlay()).toBe(true)
  })

  it('ignores an overlay inside an aria-hidden subtree', () => {
    mount('<div aria-hidden="true"><div role="dialog"></div></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores a display:none overlay', () => {
    mount('<div role="dialog" style="display: none"></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores a visibility:hidden overlay', () => {
    mount('<div role="dialog" style="visibility: hidden"></div>')

    expect(hasVisibleOverlay()).toBe(false)
  })

  it('ignores overlays inside ignoreSelector but not their siblings', () => {
    mount('<div data-page-list="true"><div role="listbox"></div></div><div role="menu"></div>')

    expect(hasVisibleOverlay({ ignoreSelector: '[data-page-list="true"]' })).toBe(true)

    document.querySelector('[role="menu"]')?.remove()

    expect(hasVisibleOverlay({ ignoreSelector: '[data-page-list="true"]' })).toBe(false)
  })
})
