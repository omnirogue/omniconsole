// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  acquireBrowserAutomationFocus,
  releaseBrowserAutomationFocus
} from './browser-automation-focus'

let nativeFocus: Element | null = null
beforeEach(() => {
  nativeFocus = document.body
  vi.spyOn(document, 'activeElement', 'get').mockImplementation(() => nativeFocus)
})

afterEach(() => {
  for (const token of ['first', 'second']) {
    releaseBrowserAutomationFocus(token)
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function page(id: string, hidden = false) {
  const host = document.createElement('div')
  host.setAttribute('data-browser-client-page-id', id)
  if (hidden) {
    host.setAttribute('inert', '')
  }
  const guest = document.createElement('input')
  // Electron native input bypasses inert; a normal DOM focus() correctly refuses it.
  vi.spyOn(guest, 'focus').mockImplementation(() => {
    nativeFocus = guest
    guest.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  host.append(guest)
  document.body.append(host)
  return { host, guest }
}

it('returns focus to the visible page after native input focuses a hidden guest', () => {
  const visible = page('visible')
  const hidden = page('hidden', true)
  visible.guest.focus()
  acquireBrowserAutomationFocus('first', 'hidden')
  hidden.guest.focus()
  expect(document.activeElement).toBe(hidden.guest)
  releaseBrowserAutomationFocus('first')
  expect(document.activeElement).toBe(visible.guest)
})

it('keeps the latest user focus when another control is chosen during automation', () => {
  const visible = page('visible')
  const hidden = page('hidden', true)
  const next = page('next')
  visible.guest.focus()
  acquireBrowserAutomationFocus('first', 'hidden')
  next.guest.focus()
  hidden.guest.focus()
  releaseBrowserAutomationFocus('first')
  expect(document.activeElement).toBe(next.guest)
})

it('does not move focus away from a page the user made visible', () => {
  const visible = page('visible')
  const hidden = page('hidden', true)
  visible.guest.focus()
  acquireBrowserAutomationFocus('first', 'hidden')
  hidden.host.removeAttribute('inert')
  hidden.guest.focus()
  releaseBrowserAutomationFocus('first')
  expect(document.activeElement).toBe(hidden.guest)
})

it('preserves the visible destination across overlapping hidden-page commands', () => {
  const visible = page('visible')
  const first = page('hidden-a', true)
  const second = page('hidden-b', true)
  visible.guest.focus()
  acquireBrowserAutomationFocus('first', 'hidden-a')
  first.guest.focus()
  acquireBrowserAutomationFocus('second', 'hidden-b')
  second.guest.focus()
  releaseBrowserAutomationFocus('first')
  expect(document.activeElement).toBe(second.guest)
  releaseBrowserAutomationFocus('second')
  expect(document.activeElement).toBe(visible.guest)
})

it('does not focus a previous destination that has been removed', () => {
  const visible = page('visible')
  const hidden = page('hidden', true)
  visible.guest.focus()
  acquireBrowserAutomationFocus('first', 'hidden')
  visible.host.remove()
  hidden.guest.focus()
  const restore = vi.spyOn(visible.guest, 'focus')
  restore.mockClear()
  releaseBrowserAutomationFocus('first')
  expect(restore).not.toHaveBeenCalled()
})

it('leaves unrelated focus alone and releases its observer exactly once', () => {
  const visible = page('visible')
  const other = page('other')
  visible.guest.focus()
  acquireBrowserAutomationFocus('first', 'hidden')
  other.guest.focus()
  const restore = vi.spyOn(visible.guest, 'focus')
  restore.mockClear()
  const remove = vi.spyOn(document, 'removeEventListener')
  releaseBrowserAutomationFocus('first')
  releaseBrowserAutomationFocus('first')
  expect(document.activeElement).toBe(other.guest)
  expect(restore).not.toHaveBeenCalled()
  expect(remove).toHaveBeenCalledExactlyOnceWith('focusin', expect.any(Function), true)
})
