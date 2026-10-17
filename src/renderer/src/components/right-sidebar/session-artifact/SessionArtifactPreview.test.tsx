// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionArtifactPreview } from './SessionArtifactPreview'

const CONTENT_URL = 'https://console.example.com/a/plan/content'

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
})
