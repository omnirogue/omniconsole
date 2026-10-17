import { beforeEach, describe, expect, it, vi } from 'vitest'

type HeadersCallback = (response: { requestHeaders?: Record<string, string> }) => void
type RequestCallback = (response: { cancel?: boolean }) => void

const fakeSession = {
  webRequest: {
    onBeforeRequest: vi.fn(),
    onBeforeSendHeaders: vi.fn()
  },
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  on: vi.fn()
}

vi.mock('electron', () => ({
  app: { isPackaged: false },
  session: {
    fromPartition: (partition: string) => {
      if (partition !== 'omni-artifact-preview') {
        throw new Error(`unexpected partition ${partition}`)
      }
      return fakeSession
    }
  }
}))
vi.mock('../browser/browser-session-proxy', () => ({
  applyProxyToBrowserSession: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../network/proxy-settings', () => ({
  getProxySessionApplicationReadiness: () => true
}))

import {
  artifactPreviewRequestHeaders,
  installArtifactPreviewSession,
  isAdmissibleArtifactPreviewAttach,
  isAllowedArtifactPreviewRequestUrl,
  isArtifactPreviewSession
} from './artifact-preview-session'

const API = 'https://console.example.com'
const CONTENT = `${API}/a/plan/content`

function details(url: string, resourceType = 'mainFrame') {
  return { url, resourceType, requestHeaders: { Accept: 'text/html' } }
}

describe('artifactPreviewRequestHeaders', () => {
  it('adds the bearer only to a top-level artifact document load', async () => {
    const getToken = vi.fn().mockResolvedValue('odt_secret')
    await expect(artifactPreviewRequestHeaders(details(CONTENT), getToken, API)).resolves.toEqual({
      Accept: 'text/html',
      Authorization: 'Bearer odt_secret'
    })
    expect(getToken).toHaveBeenCalledWith(API)
  })

  it('never adds it to subframes, subresources or other URLs', async () => {
    const getToken = vi.fn().mockResolvedValue('odt_secret')
    for (const request of [
      details(CONTENT, 'subFrame'),
      details(CONTENT, 'xhr'),
      details(`${API}/v1/artifacts/plan/review`),
      details('https://cdn.example.com/a/plan/content'),
      details(`${API}/a/plan/content?x=1`)
    ]) {
      await expect(artifactPreviewRequestHeaders(request, getToken, API)).resolves.toBeNull()
    }
    expect(getToken).not.toHaveBeenCalled()
  })

  it('loads without a header when signed out or the token lookup fails', async () => {
    await expect(
      artifactPreviewRequestHeaders(details(CONTENT), vi.fn().mockResolvedValue(null), API)
    ).resolves.toBeNull()
    await expect(
      artifactPreviewRequestHeaders(
        details(CONTENT),
        vi.fn().mockRejectedValue(new Error('x')),
        API
      )
    ).resolves.toBeNull()
  })
})

describe('isAllowedArtifactPreviewRequestUrl', () => {
  it('lets pages load the web and inline data', () => {
    expect(isAllowedArtifactPreviewRequestUrl('https://cdn.jsdelivr.net/npm/x.js', API)).toBe(true)
    expect(isAllowedArtifactPreviewRequestUrl('wss://socket.example.com', API)).toBe(true)
    expect(isAllowedArtifactPreviewRequestUrl('data:image/png;base64,AA', API)).toBe(true)
    expect(isAllowedArtifactPreviewRequestUrl(CONTENT, API)).toBe(true)
  })

  it('keeps pages off this machine', () => {
    expect(isAllowedArtifactPreviewRequestUrl('file:///etc/passwd', API)).toBe(false)
    expect(isAllowedArtifactPreviewRequestUrl('http://127.0.0.1:4455/rpc', API)).toBe(false)
    expect(isAllowedArtifactPreviewRequestUrl('http://localhost:5173/', API)).toBe(false)
    expect(isAllowedArtifactPreviewRequestUrl('ws://[::1]:9000/', API)).toBe(false)
    expect(isAllowedArtifactPreviewRequestUrl('omni-preview://grant/x', API)).toBe(false)
  })

  it('allows a loopback artifact server only when it is the configured API', () => {
    expect(
      isAllowedArtifactPreviewRequestUrl(
        'http://localhost:3000/a/p/content',
        'http://localhost:3000'
      )
    ).toBe(true)
  })
})

describe('installArtifactPreviewSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('admits only the preview partition with an artifact document URL', () => {
    expect(isAdmissibleArtifactPreviewAttach('omni-artifact-preview', CONTENT)).toBe(true)
    expect(isAdmissibleArtifactPreviewAttach('persist:omni-default', CONTENT)).toBe(false)
    expect(isAdmissibleArtifactPreviewAttach('omni-artifact-preview', 'https://example.com/')).toBe(
      false
    )
  })

  it('denies permissions and downloads, filters requests and adds the bearer in main', async () => {
    const getToken = vi.fn().mockResolvedValue('odt_secret')
    installArtifactPreviewSession(getToken)
    expect(isArtifactPreviewSession(fakeSession as never)).toBe(true)

    const permissionCallback = vi.fn()
    fakeSession.setPermissionRequestHandler.mock.calls[0]?.[0](null, 'media', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)
    const preventDefault = vi.fn()
    const willDownload = fakeSession.on.mock.calls.find(([event]) => event === 'will-download')
    willDownload?.[1]({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    const onBeforeRequest = fakeSession.webRequest.onBeforeRequest.mock.calls[0]?.[0]
    const requestCallback = vi.fn<RequestCallback>()
    onBeforeRequest({ url: 'file:///Users/me/.ssh/id_rsa' }, requestCallback)
    expect(requestCallback).toHaveBeenCalledWith({ cancel: true })

    const onBeforeSendHeaders = fakeSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0]
    const headersCallback = vi.fn<HeadersCallback>()
    onBeforeSendHeaders(details(CONTENT), headersCallback)
    await vi.waitFor(() => expect(headersCallback).toHaveBeenCalled())
    expect(headersCallback).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'text/html', Authorization: 'Bearer odt_secret' }
    })
  })
})
