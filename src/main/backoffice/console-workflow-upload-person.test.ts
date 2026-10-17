import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflowUpload } from './console-workflow-transport'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const principal = 'a'.repeat(64)
const current = vi.fn(() => true)
const path = '/api/gtd/hub/api/board/btk_parent1234/files/upload'
const upload = {
  files: [{ name: 'result.txt', contentType: 'text/plain', bytes: new Uint8Array([65]) }],
  instructions: 'Retain selected current input.'
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: { bearer: 'test-only', baseUrl: 'https://console.test', principal, isCurrent: () => true }
  })
})
it('refuses another captured principal before sending any input bytes', async () => {
  const result = await requestConsoleWorkflowUpload(
    path,
    z.object({ ok: z.literal(true) }),
    upload,
    1000,
    'b'.repeat(64),
    current
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'principal_mismatch' } })
  expect(fetchMock).not.toHaveBeenCalled()
})
it('refuses a revoked original capture before sending any input bytes', async () => {
  current.mockReturnValue(false)
  const result = await requestConsoleWorkflowUpload(
    path,
    z.object({ ok: z.literal(true) }),
    upload,
    1000,
    principal,
    current
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
  expect(fetchMock).not.toHaveBeenCalled()
})
it('does not accept an upload receipt after the original capture identity changes', async () => {
  fetchMock.mockImplementationOnce(async () => {
    current.mockReturnValue(false)
    return new Response(JSON.stringify({ ok: true }))
  })
  const result = await requestConsoleWorkflowUpload(
    path,
    z.object({ ok: z.literal(true) }),
    upload,
    1000,
    principal,
    current
  )
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
})
