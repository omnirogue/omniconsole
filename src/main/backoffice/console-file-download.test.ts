import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'
import { downloadVerifiedConsoleFile } from './console-file-download'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => {
    const serialized = JSON.stringify(value)
    return serialized === undefined
      ? value
      : JSON.parse(serialized.replaceAll('download-bearer-sentinel', '[redacted]'))
  }
}))

const route = '/api/gtd/hub/api/board/btk_download1234/files/download?path=files%2Fname.txt'
const bytes = Buffer.from([0, 255, 1, 254])
const captured = capturedHandoffFile('name.txt', bytes)
const metadata = {
  name: captured.name,
  available: true,
  size: captured.size,
  sha256: captured.sha256
}
const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'download-bearer-sentinel',
      baseUrl: 'https://console.test',
      principal: 'download-person',
      isCurrent
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('verified signed task file download', () => {
  it('fetches the exact allowed route as the captured person and returns the pinned bytes', async () => {
    const response = new Response(bytes)
    fetchMock.mockResolvedValueOnce(response)
    expect(await downloadVerifiedConsoleFile(route, metadata)).toEqual({ ok: true, data: captured })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://console.test${route}`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer download-bearer-sentinel' },
        credentials: 'omit',
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    )
    const init = fetchMock.mock.calls[0][1]!
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.body).toBeUndefined()
    expect(response.bodyUsed).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it.each([
    'https://other.test/file',
    '/api/private/download',
    `${route}&destination=https%3A%2F%2Fother.test`
  ])('rejects unsupported route %s before credentials or network', async (path) => {
    expect(await downloadVerifiedConsoleFile(path, metadata)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves sign-in refusal without making a request', async () => {
    const refused = {
      ok: false as const,
      error: { code: 'signed_in_required', message: 'Sign in before downloading.' }
    }
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValueOnce(refused)
    expect(await downloadVerifiedConsoleFile(route, metadata)).toEqual(refused)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'hash', changed: { sha256: 'a'.repeat(64) } },
    { label: 'size', changed: { size: metadata.size + 1 } }
  ])('rejects content that differs from its pinned $label', async ({ changed }) => {
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    expect(await downloadVerifiedConsoleFile(route, { ...metadata, ...changed })).toMatchObject({
      ok: false,
      error: { code: 'file_changed' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refuses an account change before sending the captured credential', async () => {
    isCurrent.mockReturnValue(false)
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    expect(await downloadVerifiedConsoleFile(route, metadata)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discards streamed bytes when the captured person changes during the download', async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (stream) => {
          controller = stream
        }
      })
    )
    fetchMock.mockResolvedValueOnce(response)
    const pending = downloadVerifiedConsoleFile(route, metadata)
    await vi.waitFor(() => expect(response.body?.locked).toBe(true))
    controller!.enqueue(bytes.subarray(0, 2))
    isCurrent.mockReturnValue(false)
    controller!.enqueue(bytes.subarray(2))
    controller!.close()
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(response.bodyUsed).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it.each([
    { label: 'negative size', changed: { size: -1 } },
    { label: 'NaN size', changed: { size: Number.NaN } },
    { label: 'fractional size', changed: { size: 1.5 } },
    { label: 'invalid digest', changed: { sha256: 'not-a-sha256' } },
    { label: 'empty name', changed: { name: '' } },
    { label: 'absolute name', changed: { name: '/name.txt' } },
    { label: 'traversal name', changed: { name: '../name.txt' } },
    { label: 'Windows path', changed: { name: 'folder\\name.txt' } },
    { label: 'NUL name', changed: { name: 'name\0.txt' } },
    { label: 'long name', changed: { name: 'a'.repeat(256) } }
  ])('refuses malformed metadata with $label before network', async ({ changed }) => {
    fetchMock.mockResolvedValueOnce(new Response(bytes))
    expect(await downloadVerifiedConsoleFile(route, { ...metadata, ...changed })).toMatchObject({
      ok: false
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { changed: { available: false }, code: 'file_unavailable' },
    { changed: { size: HANDOFF_FILE_MAX_BYTES + 1 }, code: 'invalid_request' }
  ])('refuses unavailable or oversized metadata before network: %j', async ({ changed, code }) => {
    expect(await downloadVerifiedConsoleFile(route, { ...metadata, ...changed })).toMatchObject({
      ok: false,
      error: { code }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves a sanitized server refusal without returning credential text', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: { code: 'file_access_denied', message: 'Denied for download-bearer-sentinel.' }
        },
        { status: 403 }
      )
    )
    const result = await downloadVerifiedConsoleFile(route, metadata)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'file_access_denied', message: 'Denied for [redacted].', status: 403 }
    })
    expect(JSON.stringify(result)).not.toContain('download-bearer-sentinel')
  })

  it('omits credential-bearing network exception details', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Transport failed for download-bearer-sentinel.'))
    const result = await downloadVerifiedConsoleFile(route, metadata)
    expect(result).toMatchObject({ ok: false, error: { code: 'file_unavailable' } })
    expect(JSON.stringify(result)).not.toContain('download-bearer-sentinel')
  })

  it('consumes malformed JSON refusals and releases the response reader', async () => {
    const response = new Response('{invalid-json', {
      status: 403,
      headers: { 'content-type': 'application/json' }
    })
    fetchMock.mockResolvedValueOnce(response)
    expect(await downloadVerifiedConsoleFile(route, metadata)).toMatchObject({
      ok: false,
      error: { code: 'file_unavailable', message: 'The server refused this file (HTTP 403).' }
    })
    expect(response.bodyUsed).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it.each(['advertised', 'streamed'])(
    'cancels an oversized JSON refusal with %s length',
    async (kind) => {
      const cancel = vi.fn()
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            if (kind === 'streamed') {
              controller.enqueue(new Uint8Array(65_537))
            }
          },
          cancel
        }),
        {
          status: 503,
          headers: {
            'content-type': 'application/json',
            ...(kind === 'advertised' ? { 'content-length': '65537' } : {})
          }
        }
      )
      fetchMock.mockResolvedValueOnce(response)
      expect(await downloadVerifiedConsoleFile(route, metadata)).toMatchObject({
        ok: false,
        error: { code: 'file_unavailable', message: 'The server refused this file (HTTP 503).' }
      })
      expect(cancel).toHaveBeenCalledOnce()
      expect(response.bodyUsed).toBe(true)
      expect(response.body?.locked).toBe(false)
    }
  )

  it('releases a failing download stream and omits its transport exception', async () => {
    let reads = 0
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (reads++ === 0) {
            controller.enqueue(bytes)
          } else {
            controller.error(new Error('Download failed for download-bearer-sentinel.'))
          }
        }
      })
    )
    fetchMock.mockResolvedValueOnce(response)
    const result = await downloadVerifiedConsoleFile(route, metadata)
    expect(result).toMatchObject({ ok: false, error: { code: 'file_unavailable' } })
    expect(response.bodyUsed).toBe(true)
    expect(response.body?.locked).toBe(false)
    expect(JSON.stringify(result)).not.toContain('download-bearer-sentinel')
  })
})
