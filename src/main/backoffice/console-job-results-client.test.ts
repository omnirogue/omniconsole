import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readConsoleJobResults } from './console-job-results-client'

const state = vi.hoisted(() => ({ current: true, principal: 'person' }))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: async () => {
    const principal = state.principal
    return {
      ok: true,
      data: {
        bearer: 'results-fixture-token',
        baseUrl: 'https://console.example.test',
        principal,
        isCurrent: () => state.current && state.principal === principal
      }
    }
  },
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const jobId = 'job_results0001'
const attempt = 7
const taskId = 'btk_results001'
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const content = 'The produced report.\n'
const report = {
  schema_version: 1,
  kind: 'folder_report',
  job_id: jobId,
  attempt,
  response: 'The report is ready.',
  changed_files: ['report.md'],
  files: [
    {
      path: 'report.md',
      mode: 0o644,
      sha256: digest(content),
      size_bytes: Buffer.byteLength(content),
      content_b64: Buffer.from(content).toString('base64')
    }
  ]
}
const reportText = JSON.stringify(report)
const receipt = {
  job_id: jobId,
  attempt,
  file_id: 'tfl_results001',
  principal: 'person',
  sha256: digest(reportText),
  rel: 'results/attempt 7/report.json',
  size_bytes: Buffer.byteLength(reportText)
}
const job = {
  id: jobId,
  task_id: taskId,
  title: 'Produce the report',
  status: 'done',
  attempt,
  execution_artifacts: [receipt],
  policy: {}
}
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  state.current = true
  state.principal = 'person'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock
    .mockResolvedValueOnce(Response.json(job))
    .mockResolvedValueOnce(new Response(reportText))
    .mockResolvedValueOnce(Response.json(job))
})

describe('job result read boundary', () => {
  it('downloads the signed task artifact and rechecks the same attempt before returning files', async () => {
    expect(await readConsoleJobResults({ jobId, attempt })).toEqual({
      ok: true,
      data: {
        job_id: jobId,
        attempt,
        receipt,
        response: report.response,
        changed_files: report.changed_files,
        files: report.files
      }
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://console.example.test/api/gtd/jobs/job_results0001',
      'https://console.example.test/api/gtd/hub/api/board/btk_results001/files/download?path=results%2Fattempt%207%2Freport.json',
      'https://console.example.test/api/gtd/jobs/job_results0001'
    ])
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: 'Bearer results-fixture-token' }
      })
    }
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      'Accept-Encoding': 'identity'
    })
  })

  it.each([{ execution_artifacts: [] }, { task_id: 'unbound_external_task' }])(
    'does not download without a task-bound result receipt: %j',
    async (patch) => {
      fetchMock.mockReset().mockResolvedValue(Response.json({ ...job, ...patch }))
      expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
        ok: false,
        error: { code: 'result_unavailable' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([{ id: 'job_other0001' }, { attempt: 8 }])(
    'rejects a job response for a different job or attempt: %j',
    async (patch) => {
      fetchMock.mockReset().mockResolvedValue(Response.json({ ...job, ...patch }))
      expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([{ job_id: 'job_other0001' }, { attempt: 6 }])(
    'never follows a receipt from another job or attempt: %j',
    async (patch) => {
      fetchMock.mockReset().mockResolvedValue(
        Response.json({
          ...job,
          execution_artifacts: [{ ...receipt, ...patch }]
        })
      )
      expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
        ok: false,
        error: { code: 'result_unavailable' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses downloaded bytes that differ from the saved report digest', async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(Response.json(job))
      .mockResolvedValueOnce(new Response(reportText.replace('ready', 'other')))
    expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
      ok: false,
      error: { code: 'result_unavailable' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    { execution_artifacts: [{ ...receipt, sha256: 'f'.repeat(64) }] },
    { execution_artifacts: [] },
    { task_id: 'btk_other0001' }
  ])(
    'discards files when the pinned receipt or task changes during download: %j',
    async (patch) => {
      fetchMock
        .mockReset()
        .mockResolvedValueOnce(Response.json(job))
        .mockResolvedValueOnce(new Response(reportText))
        .mockResolvedValueOnce(Response.json({ ...job, ...patch }))
      expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
        ok: false,
        error: { code: 'result_changed' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    }
  )

  it('does not return an earlier attempt after the job advances during download', async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(Response.json(job))
      .mockResolvedValueOnce(new Response(reportText))
      .mockResolvedValueOnce(Response.json({ ...job, attempt: 8 }))
    expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('discards a completed download if the signed-in connection changes', async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(Response.json(job))
      .mockImplementationOnce(async () => {
        state.current = false
        return new Response(reportText)
      })
    expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not recheck the job with a different person’s credentials', async () => {
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(Response.json(job))
      .mockImplementationOnce(async () => {
        state.principal = 'another-person'
        return new Response(reportText)
      })
    expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['job', 'download'])('preserves a signed %s access refusal', async (stage) => {
    fetchMock.mockReset()
    if (stage === 'download') {
      fetchMock.mockResolvedValueOnce(Response.json(job))
    }
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: { code: 'task_file_forbidden', message: 'Not assigned to this task.' }
        },
        { status: 403 }
      )
    )
    expect(await readConsoleJobResults({ jobId, attempt })).toMatchObject({
      ok: false,
      error: {
        code: 'task_file_forbidden',
        message: 'Not assigned to this task.',
        status: 403
      }
    })
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'job' ? 1 : 2)
  })

  it('does not fetch results without an explicit valid attempt', async () => {
    expect(await readConsoleJobResults({ jobId, attempt: 0 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
