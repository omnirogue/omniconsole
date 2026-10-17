// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaneFocusContext } from '@/components/pane-focus-context'
import { OpenInPaneContext } from '@/components/open-in-pane-context'
import type { BrowserPagePane } from '../browser-pane/assemble-chrome/browser-page-pane'
import type { OmniOSDocumentStatus } from './use-omnios-document-status'

const VISIBLE_UNFOCUSED = { visible: true, focused: false }
const HIDDEN_FOCUSED = { visible: false, focused: true }
const VISIBLE_FOCUSED = { visible: true, focused: true }

const mocks = vi.hoisted(() => ({
  state: { settings: { commandCenter: true, backofficeProductionUrl: 'https://omnios.example' } },
  browser: null as Parameters<typeof BrowserPagePane>[0] | null,
  status: null as ((status: OmniOSDocumentStatus) => void) | null,
  openLink: null as ((event: { browserPageId: string; url: string }) => void) | null,
  destroy: vi.fn(),
  openHttp: vi.fn(),
  unsub: vi.fn(),
  windowVisible: true
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (value: typeof mocks.state) => unknown) => select(mocks.state)
}))
vi.mock('@/lib/http-link-routing', () => ({ openHttpLink: mocks.openHttp }))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => mocks.windowVisible,
  subscribeWindowParkVisibility: () => () => {}
}))
vi.mock('../browser-pane/assemble-chrome/browser-page-pane', () => ({
  BrowserPagePane: (props: Parameters<typeof BrowserPagePane>[0]) => {
    mocks.browser = props
    return <div data-testid="real-browser-surface" />
  }
}))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  destroyPersistentWebview: mocks.destroy
}))
vi.mock('./use-omnios-document-status', () => ({
  useOmniOSDocumentStatus: (
    _root: unknown,
    _base: string,
    report: (status: OmniOSDocumentStatus) => void
  ) => {
    mocks.status = report
  }
}))
import {
  OmniOSDecisionsPane,
  isDecisionUrl,
  OMNIOS_DECISIONS_PARTITION
} from './OmniOSDecisionsPane'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.settings.commandCenter = true
  mocks.windowVisible = true
  mocks.browser = null
  window.api = {
    browser: {
      onOpenLinkInOrcaTab: (listener: typeof mocks.openLink) => {
        mocks.openLink = listener
        return mocks.unsub
      }
    }
  } as unknown as typeof window.api
})
afterEach(cleanup)

it('is absent when the setting is off and creates no browser or subscription', () => {
  mocks.state.settings.commandCenter = false
  const { container } = render(<OmniOSDecisionsPane />)
  expect(container.childElementCount).toBe(0)
  expect(mocks.browser).toBeNull()
})

it('embeds the real page in the persistent partition, with visible sign-in instructions', () => {
  render(<OmniOSDecisionsPane />)
  expect(screen.getByText('Sign in to OmniOS')).toBeTruthy()
  expect(mocks.browser?.browserTab.url).toBe('https://omnios.example/work/decisions')
  expect(mocks.browser?.sessionPartition).toBe(OMNIOS_DECISIONS_PARTITION)
  expect(mocks.browser?.embedded).toBe(true)
  act(() => mocks.status?.('signed-out'))
  expect(document.querySelector('[data-decisions-status="signed-out"]')).toBeTruthy()
})

it('propagates pane/window visibility and focus to the existing browser', () => {
  const { rerender } = render(
    <PaneFocusContext.Provider value={VISIBLE_UNFOCUSED}>
      <OmniOSDecisionsPane />
    </PaneFocusContext.Provider>
  )
  expect(mocks.browser?.isActive).toBe(true)
  expect(mocks.browser?.chromeShortcutScope).toBe('inactive')
  rerender(
    <PaneFocusContext.Provider value={HIDDEN_FOCUSED}>
      <OmniOSDecisionsPane />
    </PaneFocusContext.Provider>
  )
  expect(mocks.browser?.isActive).toBe(false)
  expect(mocks.browser?.inputLocked).toBe(true)
  mocks.windowVisible = false
  rerender(
    <PaneFocusContext.Provider value={VISIBLE_FOCUSED}>
      <OmniOSDecisionsPane />
    </PaneFocusContext.Provider>
  )
  expect(mocks.browser?.isActive).toBe(false)
  mocks.windowVisible = true
  rerender(
    <PaneFocusContext.Provider value={VISIBLE_FOCUSED}>
      <OmniOSDecisionsPane />
    </PaneFocusContext.Provider>
  )
  expect(mocks.browser?.isActive).toBe(true)
  expect(mocks.browser?.chromeShortcutScope).toBe('focused')
})

it('shows unavailable before success and stale after a successful page load', () => {
  render(<OmniOSDecisionsPane />)
  const id = mocks.browser!.browserTab.id
  const failure = {
    code: -105,
    description: 'Unreachable',
    validatedUrl: 'https://omnios.example/work/decisions'
  }
  act(() => mocks.browser!.onUpdatePageState(id, { loading: false, loadError: failure }))
  expect(document.querySelector('[data-decisions-status="unavailable"]')).toBeTruthy()
  act(() => {
    mocks.browser!.onUpdatePageState(id, { loadError: null })
    mocks.status?.('ready')
  })
  act(() => mocks.browser!.onUpdatePageState(id, { loadError: failure }))
  expect(document.querySelector('[data-decisions-status="stale"]')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('Last loaded at')
})

it('keeps decision details in the same guest and routes other page links through the provider', () => {
  const open = vi.fn()
  render(
    <OpenInPaneContext.Provider value={open}>
      <OmniOSDecisionsPane />
    </OpenInPaneContext.Provider>
  )
  const id = mocks.browser!.browserTab.id
  act(() =>
    mocks.openLink?.({ browserPageId: id, url: 'https://omnios.example/work/decisions/ask-1' })
  )
  expect(mocks.browser!.browserTab.id).toBe(id)
  expect(mocks.browser!.browserTab.url).toContain('/decisions/ask-1')
  expect(open).not.toHaveBeenCalled()
  act(() => mocks.openLink?.({ browserPageId: id, url: 'https://omnios.example/a/review' }))
  expect(open).toHaveBeenCalledWith('https://omnios.example/a/review')
  act(() =>
    mocks.openLink?.({ browserPageId: 'other-page', url: 'https://omnios.example/a/other' })
  )
  expect(open).toHaveBeenCalledOnce()
})

it('hides new-pane without a provider and preserves the system-browser opener', async () => {
  render(<OmniOSDecisionsPane />)
  await userEvent.click(screen.getByRole('button', { name: 'Decision page actions' }))
  expect(screen.queryByRole('menuitem', { name: 'Open in new pane' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in browser' }))
  expect(mocks.openHttp).toHaveBeenCalledWith('https://omnios.example/work/decisions', {
    forceSystemBrowser: true
  })
})

it('offers the explicit new-pane callback', async () => {
  const open = vi.fn()
  render(
    <OmniOSDecisionsPane onOpenInNewPane={open} url="https://omnios.example/work/decisions/ask-2" />
  )
  await userEvent.click(screen.getByRole('button', { name: 'Decision page actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new pane' }))
  expect(open).toHaveBeenCalledWith('https://omnios.example/work/decisions/ask-2')
})

it('owns cleanup without destroying a StrictMode remount', async () => {
  const { unmount } = render(
    <StrictMode>
      <OmniOSDecisionsPane />
    </StrictMode>
  )
  await act(async () => {})
  expect(mocks.destroy).not.toHaveBeenCalled()
  const id = mocks.browser!.browserTab.id
  unmount()
  await act(async () => {})
  expect(mocks.destroy).toHaveBeenCalledWith(id)
  expect(mocks.unsub).toHaveBeenCalled()
})

it('recognizes only host-qualified decision URLs, including base paths', () => {
  expect(
    isDecisionUrl(
      'https://omnios.example/console/work/decisions/ask',
      'https://omnios.example/console'
    )
  ).toBe(true)
  expect(isDecisionUrl('https://attacker.example/work/decisions', 'https://omnios.example')).toBe(
    false
  )
  expect(
    isDecisionUrl('https://omnios.example/work/decisions-fake', 'https://omnios.example')
  ).toBe(false)
  expect(isDecisionUrl('not a URL', 'https://omnios.example')).toBe(false)
})

it('updates a supplied detail URL without replacing the browser guest', () => {
  const { rerender } = render(
    <OmniOSDecisionsPane url="https://omnios.example/work/decisions/first" />
  )
  const id = mocks.browser!.browserTab.id
  rerender(<OmniOSDecisionsPane url="https://omnios.example/work/decisions/second" />)
  expect(mocks.browser!.browserTab.id).toBe(id)
  expect(mocks.browser!.browserTab.url).toBe('https://omnios.example/work/decisions/second')
  rerender(<OmniOSDecisionsPane url="javascript:alert(1)" />)
  expect(mocks.browser!.browserTab.url).toBe('https://omnios.example/work/decisions')
})
