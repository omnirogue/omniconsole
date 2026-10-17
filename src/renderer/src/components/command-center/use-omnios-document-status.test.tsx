// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  OMNIOS_DOCUMENT_STATUS_SCRIPT,
  parseOmniOSDocumentStatus,
  useOmniOSDocumentStatus
} from './use-omnios-document-status'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

it('reads only the real page presentation state, including sign-in at the Decisions URL', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  document.body.innerHTML = '<div class="cl-signIn-root">Sign in</div>'
  const evaluate = new Function(OMNIOS_DOCUMENT_STATUS_SCRIPT)
  evaluate()
  expect(log).toHaveBeenLastCalledWith('omni-decisions-document-status:signed-out')
  document.body.innerHTML = '<div data-testid="auth-loading-clerk">Loading sign-in</div>'
  evaluate()
  expect(log).toHaveBeenLastCalledWith('omni-decisions-document-status:loading')
  document.body.innerHTML = '<div data-testid="auth-error">Could not restore session</div>'
  evaluate()
  expect(log).toHaveBeenLastCalledWith('omni-decisions-document-status:unavailable')
  document.body.innerHTML = '<main>Waiting for my decision</main>'
  evaluate()
  expect(log).toHaveBeenLastCalledWith('omni-decisions-document-status:ready')
  const observer = (window as unknown as { __omniDecisionsStatusObserver: MutationObserver })
    .__omniDecisionsStatusObserver
  observer.disconnect()
})

it('accepts only allowlisted status messages', () => {
  expect(parseOmniOSDocumentStatus('omni-decisions-document-status:signed-out')).toBe('signed-out')
  expect(parseOmniOSDocumentStatus('omni-decisions-document-status:{"token":"secret"}')).toBeNull()
  expect(parseOmniOSDocumentStatus('other message')).toBeNull()
})

it('observes only this origin, reattaches after guest replacement, and releases listeners', async () => {
  const root = document.createElement('div')
  const makeGuest = () => {
    const guest = document.createElement('webview') as Electron.WebviewTag
    Object.assign(guest, {
      getURL: vi.fn(() => 'https://omnios.example/work/decisions'),
      executeJavaScript: vi.fn(async () => {})
    })
    return guest
  }
  const first = makeGuest()
  root.append(first)
  const report = vi.fn()
  const { unmount } = renderHook(() =>
    useOmniOSDocumentStatus(root, 'https://omnios.example', report)
  )
  const send = (
    guest: Electron.WebviewTag,
    message = 'omni-decisions-document-status:signed-out'
  ) => {
    const event = new Event('console-message')
    Object.assign(event, { message })
    guest.dispatchEvent(event)
  }
  send(first)
  expect(report).toHaveBeenCalledWith('signed-out')
  vi.mocked(first.getURL).mockReturnValue('https://accounts.example/sign-in')
  send(first)
  expect(report).toHaveBeenCalledOnce()
  const replacement = makeGuest()
  await act(async () => {
    first.replaceWith(replacement)
  })
  send(first)
  send(replacement, 'omni-decisions-document-status:ready')
  expect(report).toHaveBeenCalledTimes(2)
  expect(replacement.executeJavaScript).toHaveBeenCalledWith(OMNIOS_DOCUMENT_STATUS_SCRIPT)
  unmount()
  send(replacement)
  expect(report).toHaveBeenCalledTimes(2)
})
