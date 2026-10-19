// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionArtifactPreview } from './SessionArtifactPreview'

const CONTENT_URL = 'https://console.example.com/a/plan/content'
const SCROLL_READ = '[window.scrollX, window.scrollY]'

function emit(webview: Element, type: string, fields: Record<string, unknown> = {}): void {
  act(() => {
    webview.dispatchEvent(Object.assign(new Event(type), fields))
  })
}

function showsLoadingOverlay(): boolean {
  return document.querySelector('.animate-spin') !== null
}

/** Renders a preview whose first document has finished loading, with guest calls stubbed. */
function renderShownPreview(executeJavaScript: (code: string) => Promise<unknown>) {
  const view = render(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={3} />)
  const webview = document.querySelector('webview') as Electron.WebviewTag
  const reloadIgnoringCache = vi.fn()
  const execute = vi.fn(executeJavaScript)
  Object.assign(webview, { reloadIgnoringCache, executeJavaScript: execute })
  emit(webview, 'did-stop-loading')
  return { ...view, webview, reloadIgnoringCache, executeJavaScript: execute }
}

describe('SessionArtifactPreview', () => {
  afterEach(() => {
    cleanup()
  })

  it('loads the artifact document in the isolated preview partition with no credential', () => {
    render(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={null} />)

    const webview = document.querySelector('webview')
    expect(webview).not.toBeNull()
    expect(webview?.getAttribute('partition')).toBe('omni-artifact-preview')
    expect(webview?.getAttribute('src')).toBe(CONTENT_URL)
    expect(webview?.hasAttribute('preload')).toBe(false)
    expect(webview?.hasAttribute('nodeintegration')).toBe(false)
    // The renderer holds only the URL: no attribute or query string carries a token.
    const attributes = Array.from(webview?.attributes ?? []).map((a) => `${a.name}=${a.value}`)
    expect(attributes.join(' ')).not.toMatch(/bearer|odt_|token|authorization/i)
  })

  it('reloads the page when the revision changes, not on the first answer', () => {
    const { rerender } = render(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={null} />)
    const webview = document.querySelector('webview') as Electron.WebviewTag
    const reloadIgnoringCache = vi.fn()
    Object.assign(webview, { reloadIgnoringCache })

    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={3} />)
    expect(reloadIgnoringCache).not.toHaveBeenCalled()
    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={3} />)
    expect(reloadIgnoringCache).not.toHaveBeenCalled()
    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={4} />)
    expect(reloadIgnoringCache).toHaveBeenCalledOnce()
  })

  it('treats a different artifact as a fresh page, not a revision change', () => {
    const { rerender } = render(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={3} />)
    const other = 'https://console.example.com/a/other/content'
    rerender(<SessionArtifactPreview contentUrl={other} revision={null} />)
    const webview = document.querySelector('webview') as Electron.WebviewTag
    expect(webview.getAttribute('src')).toBe(other)
    const reloadIgnoringCache = vi.fn()
    Object.assign(webview, { reloadIgnoringCache })

    rerender(<SessionArtifactPreview contentUrl={other} revision={3} />)
    expect(reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('shows the loading overlay on the first load until the document stops loading', () => {
    render(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={null} />)
    const webview = document.querySelector('webview') as Electron.WebviewTag
    expect(showsLoadingOverlay()).toBe(true)

    emit(webview, 'did-start-loading')
    expect(showsLoadingOverlay()).toBe(true)
    emit(webview, 'did-stop-loading')
    expect(showsLoadingOverlay()).toBe(false)
  })

  it('reloads a shown document in place and restores its scroll offset', async () => {
    const { rerender, webview, reloadIgnoringCache, executeJavaScript } = renderShownPreview(
      async (code) => (code === SCROLL_READ ? [12, 340] : undefined)
    )

    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={4} />)
    await vi.waitFor(() => expect(reloadIgnoringCache).toHaveBeenCalledOnce())
    expect(executeJavaScript).toHaveBeenCalledOnce()
    expect(executeJavaScript).toHaveBeenCalledWith(SCROLL_READ)

    emit(webview, 'did-start-loading')
    expect(showsLoadingOverlay()).toBe(false)
    emit(webview, 'did-stop-loading')
    expect(showsLoadingOverlay()).toBe(false)
    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(executeJavaScript).toHaveBeenLastCalledWith('window.scrollTo(12, 340)')
  })

  it('still reloads without a restore when the scroll offset cannot be read', async () => {
    const { rerender, webview, reloadIgnoringCache, executeJavaScript } = renderShownPreview(
      async (code) => {
        if (code === SCROLL_READ) {
          throw new Error('guest not ready')
        }
      }
    )

    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={4} />)
    await vi.waitFor(() => expect(reloadIgnoringCache).toHaveBeenCalledOnce())
    emit(webview, 'did-start-loading')
    expect(showsLoadingOverlay()).toBe(false)
    emit(webview, 'did-stop-loading')
    expect(executeJavaScript).toHaveBeenCalledOnce()
  })

  it('never writes a page-supplied value that is not a pair of numbers back into the guest', async () => {
    const { rerender, webview, reloadIgnoringCache, executeJavaScript } = renderShownPreview(
      async (code) => (code === SCROLL_READ ? ['0);alert(1', 2] : undefined)
    )

    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={4} />)
    await vi.waitFor(() => expect(reloadIgnoringCache).toHaveBeenCalledOnce())
    emit(webview, 'did-stop-loading')
    expect(executeJavaScript).toHaveBeenCalledOnce()
  })

  it('shows Preview unavailable when an in-place reload fails', async () => {
    const { rerender, webview, reloadIgnoringCache } = renderShownPreview(async () => [0, 0])

    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={4} />)
    await vi.waitFor(() => expect(reloadIgnoringCache).toHaveBeenCalledOnce())
    emit(webview, 'did-start-loading')
    emit(webview, 'did-fail-load', { isMainFrame: true, errorCode: -105 })
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
  })

  it('shows Preview unavailable when an in-place reload times out', async () => {
    const { rerender, webview, reloadIgnoringCache } = renderShownPreview(async () => [0, 0])
    rerender(<SessionArtifactPreview contentUrl={CONTENT_URL} revision={4} />)
    await vi.waitFor(() => expect(reloadIgnoringCache).toHaveBeenCalledOnce())

    vi.useFakeTimers()
    try {
      emit(webview, 'did-start-loading')
      act(() => {
        vi.advanceTimersByTime(20_000)
      })
      expect(screen.getByText('Preview unavailable')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a new artifact its own first-load overlay after an in-place reload', () => {
    const { rerender } = renderShownPreview(async () => [0, 0])
    expect(showsLoadingOverlay()).toBe(false)

    rerender(
      <SessionArtifactPreview
        contentUrl="https://console.example.com/a/other/content"
        revision={3}
      />
    )
    expect(showsLoadingOverlay()).toBe(true)
  })
})
