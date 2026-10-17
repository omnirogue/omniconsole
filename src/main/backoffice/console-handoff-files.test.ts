import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadHandoffFile, uploadHandoffFile } from './console-handoff-files'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const bytes = Buffer.from([0, 255, 1, 254])
const captured = capturedHandoffFile('report.pdf', bytes)
const request = {
  threadId: 'hth_sample',
  file: {
    id: 'hfv_original',
    name: captured.name,
    path: 'uploads/report.pdf',
    size: captured.size,
    sha256: captured.sha256,
    version: 1,
    parent_version_id: null,
    current: true,
    available: true
  }
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
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent
    }
  } as never)
})
afterEach(() => vi.unstubAllGlobals())

it('refuses task file uploads without the original principal or under a different signed person', async () => {
  expect(
    await uploadHandoffFile({ taskId: 'btk_audit0001', file: captured, purpose: 'task' })
  ).toMatchObject({ ok: false })
  expect(
    await uploadHandoffFile({
      taskId: 'btk_audit0001',
      file: captured,
      purpose: 'task',
      expectedPrincipal: 'a'.repeat(64)
    })
  ).toMatchObject({ ok: false })
  expect(fetchMock).not.toHaveBeenCalled()
})

describe('handoff download response lifecycle', () => {
  it('preserves the server refusal so the person can understand a blocked download', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'handoff_access_denied',
            message: 'This file is no longer shared with you.'
          }
        },
        { status: 403 }
      )
    )
    expect(await downloadHandoffFile(request)).toMatchObject({
      ok: false,
      error: {
        code: 'handoff_access_denied',
        message: 'This file is no longer shared with you.',
        status: 403
      }
    })
  })

  it.each([401, 404, 503])('cancels the unread body after HTTP %i', async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(bytes),
      cancel
    })
    const response = new Response(body, { status })
    fetchMock.mockResolvedValueOnce(response)

    expect(await downloadHandoffFile(request)).toMatchObject({
      ok: false,
      error: { code: 'file_unavailable', message: `The server refused this file (HTTP ${status}).` }
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.bodyUsed).toBe(true)
  })

  it('keeps the HTTP failure when cancelling an already failing stream rejects', async () => {
    const response = new Response(
      new ReadableStream({
        cancel: () => Promise.reject(new Error('socket closed'))
      }),
      { status: 503 }
    )
    fetchMock.mockResolvedValueOnce(response)

    expect(await downloadHandoffFile(request)).toMatchObject({
      ok: false,
      error: { message: 'The server refused this file (HTTP 503).' }
    })
    expect(response.bodyUsed).toBe(true)
  })

  it('cancels an oversized response before returning the download error', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(HANDOFF_FILE_MAX_BYTES + 1) }
    })
    fetchMock.mockResolvedValueOnce(response)

    expect(await downloadHandoffFile(request)).toMatchObject({
      ok: false,
      error: { code: 'file_unavailable' }
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.bodyUsed).toBe(true)
  })

  it.each([true, false])(
    'consumes the response and accepts it only when the account remains current: %s',
    async (current) => {
      const response = new Response(bytes)
      fetchMock.mockImplementationOnce(async () => {
        isCurrent.mockReturnValue(current)
        return response
      })

      expect(await downloadHandoffFile(request)).toEqual(
        current
          ? { ok: true, data: captured }
          : expect.objectContaining({
              ok: false,
              error: expect.objectContaining({ code: 'connection_changed' })
            })
      )
      expect(response.bodyUsed).toBe(true)
      expect(response.body?.locked).toBe(false)
    }
  )
})
