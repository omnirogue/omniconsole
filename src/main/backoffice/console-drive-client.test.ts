import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleDriveClient as client } from './console-drive-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow } from './console-workflow-transport'
import { consoleCardDrive } from '../../shared/console-drive-contract'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const taskId = 'btk_test1234'
const root = `https://console.test/api/gtd/hub/api/board/${taskId}/drive`
const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
const folder = {
  task_id: taskId,
  supports_project_intake_precondition: true,
  destination: {
    scope: 'project',
    scope_key: 'cgl_project',
    display: 'Test project',
    target: 'drive:cgl_project'
  },
  declared: true,
  folder: {
    registry_id: 'drvf_test',
    folder_id: 'folder-test',
    link: 'https://drive.google.com/drive/folders/folder-test',
    status: 'active'
  }
}
const intake = {
  id: 'drin_test',
  task_id: taskId,
  pattern: '*.mp4',
  expected_from: 'emp_sal',
  expected_from_email: 'sal@example.test',
  expected_count: 1,
  share_role: 'writer',
  status: 'active',
  arrivals: 0,
  created_by: 'sal@example.test',
  created_at: '2026-09-15T04:00:00Z',
  folder_link: folder.folder.link,
  destination: folder.destination,
  files: []
}
const input = {
  taskId,
  expectedScopeKey: 'cgl_project',
  expected_from: 'emp_sal',
  pattern: '*.mp4',
  expected_count: 1
}
const reply = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
const call = (index = 0) => fetchMock.mock.calls[index] as [string, RequestInit]

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  isCurrent.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-bearer',
      baseUrl: 'https://console.test',
      principal: 'sal@example.test',
      isCurrent
    }
  } as never)
})

describe('the desktop Drive contract', () => {
  it('reads the scoped destination and strips unknown provider fields', async () => {
    reply({
      ...folder,
      providerSecret: 'must-not-cross',
      folder: { ...folder.folder, arbitrary: true }
    })
    const result = await client.get({ taskId })
    expect(result).toEqual({ ok: true, data: folder })
    expect(call()[0]).toBe(root)
    expect(call()[1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
  })
  it('preserves a received file and the resolved email in the intake list', async () => {
    const row = {
      ...intake,
      files: [
        {
          file_id: 'drive-file',
          name: 'movie.mp4',
          size_bytes: 499_532_353,
          link: 'https://drive.google.com/file/d/drive-file/view',
          sender_id: 'emp_sal',
          sender_email: 'sal@example.test',
          disposition: 'received',
          first_seen_at: intake.created_at
        }
      ]
    }
    reply({ task_id: taskId, intakes: [row] })
    expect(await client.intakes({ taskId })).toEqual({
      ok: true,
      data: { task_id: taskId, intakes: [row] }
    })
    expect(call()[0]).toBe(`${root}/intakes`)
  })
  it('declares through the exact POST with a longer provider-write deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    reply(folder, 201)
    expect((await client.declare({ taskId })).ok).toBe(true)
    expect(call()[0]).toBe(`${root}/declare`)
    expect(call()[1].method).toBe('POST')
    expect(JSON.parse(String(call()[1].body))).toEqual({})
    expect(timeout).toHaveBeenCalledWith(120_000)
    timeout.mockRestore()
  })
  it('rechecks project scope under one principal before sharing with the exact employee', async () => {
    reply(folder)
    reply(intake, 201)
    expect(await client.requestFiles(input)).toEqual({ ok: true, data: intake })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(call(1)[0]).toBe(`${root}/intakes`)
    expect(JSON.parse(String(call(1)[1].body))).toEqual({
      expected_from: 'emp_sal',
      pattern: '*.mp4',
      expected_count: 1,
      share_role: 'writer',
      expected_scope_key: 'cgl_project'
    })
  })
  it.each(['company', 'division', 'estate', 'future_scope'])(
    'does not share a %s folder',
    async (scope) => {
      reply({ ...folder, destination: { ...folder.destination, scope } })
      expect(await client.requestFiles(input)).toMatchObject({
        ok: false,
        error: { code: 'drive_scope_changed' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )
  it('refuses a project changed since the form was opened', async () => {
    reply({ ...folder, destination: { ...folder.destination, scope_key: 'cgl_other' } })
    expect((await client.requestFiles(input)).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('reads an older server without issuing an unguarded share', async () => {
    reply({ ...folder, supports_project_intake_precondition: undefined })
    expect(await client.requestFiles(input)).toMatchObject({
      ok: false,
      error: { code: 'capability_unavailable' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, { ...folder.destination, scope_key: 'other_project' }])(
    'keeps a missing or different returned destination uncertain',
    async (destination) => {
      reply(folder)
      reply({ ...intake, destination }, 201)
      expect(await client.requestFiles(input)).toMatchObject({
        ok: false,
        error: {
          code: 'drive_scope_unverified',
          message: expect.stringContaining('Google may have shared')
        }
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )
  it('rejects a nested intake from another task in the folder response', async () => {
    reply({ ...folder, intakes: [{ ...intake, task_id: 'btk_other' }] })
    expect((await client.get({ taskId })).ok).toBe(false)
  })
  it('refuses an identity change between the preflight and write', async () => {
    reply(folder)
    vi.mocked(captureConsoleWorkflowPerson)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          bearer: 'test-bearer',
          baseUrl: 'https://console.test',
          principal: 'sal@example.test',
          isCurrent
        }
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          bearer: 'test-bearer',
          baseUrl: 'https://console.test',
          principal: 'sal@example.test',
          isCurrent
        }
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          bearer: 'other-bearer',
          baseUrl: 'https://console.test',
          principal: 'other@example.test',
          isCurrent
        }
      } as never)
    expect(await client.requestFiles(input)).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not retry a timed-out intake creation', async () => {
    reply(folder)
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await client.requestFiles(input)).toMatchObject({
      ok: false,
      error: { code: 'backoffice_unavailable' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([404, 403, 409])(
    'preserves an older server or authorization refusal (%s)',
    async (status) => {
      reply({ detail: 'Drive is unavailable here.' }, status)
      expect(await client.get({ taskId })).toMatchObject({ ok: false, error: { status } })
    }
  )
  it.each([
    { task_id: taskId },
    { ...folder, task_id: 'btk_other123' },
    { ...folder, declared: false },
    { ...folder, folder: { ...folder.folder, link: 'javascript:alert(1)' } }
  ])('does not paint malformed or another task’s data as an empty folder', async (body) => {
    reply(body)
    expect(await client.get({ taskId })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })
  it('refuses an intake belonging to another card inside a matching list envelope', async () => {
    reply({ task_id: taskId, intakes: [{ ...intake, task_id: 'btk_other123' }] })
    expect((await client.intakes({ taskId })).ok).toBe(false)
  })
  it.each([
    { ...input, expected_from: 'sal@example.test' },
    { ...input, expected_count: 0 },
    { ...input, share_role: 'reader' },
    { ...input, taskId: '../drive' }
  ])('refuses malformed file requests before any provider call', async (value) => {
    expect((await client.requestFiles(value as never)).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    ['GET', `${root}/intakes/extra`],
    ['GET', `${root}?principal=other`],
    ['POST', `${root}/intakes/tick`],
    ['POST', `${root}/intakes/drin_test/close`],
    ['POST', root],
    ['PATCH', `${root}/declare`]
  ] as const)('keeps near-miss %s routes out of the transport', async (method, fullPath) => {
    const result = await requestConsoleWorkflow(
      fullPath.replace('https://console.test', ''),
      method,
      consoleCardDrive
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
