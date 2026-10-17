import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  captureOutcomeCurrentInputs,
  captureOutcomeSourceInputs
} from './console-outcome-current-inputs'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { readOwnedInputTask } from './console-parent-task-inputs'
import { requestConsoleWorkflow, requestConsoleWorkflowUpload } from './console-workflow-transport'
import type { OutcomeCurrentInputRuntime } from './console-outcome-current-inputs'
vi.mock('./console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('./console-parent-task-inputs', () => ({ readOwnedInputTask: vi.fn() }))
vi.mock('./console-workflow-transport', () => ({
  requestConsoleWorkflow: vi.fn(),
  requestConsoleWorkflowUpload: vi.fn()
}))
const bytes = Buffer.from('selected current contents')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const principal = 'a'.repeat(64)
const current = vi.fn(() => true)
const capture = vi.fn()
const runtime = { captureFleetSourceSnapshot: capture } as OutcomeCurrentInputRuntime
const args = {
  taskId: 'btk_parent1234',
  worktree: 'id:known-folder',
  principal,
  selectedSourcePaths: ['reports/result.txt']
}
beforeEach(() => {
  vi.resetAllMocks()
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: { principal, bearer: 'test', baseUrl: 'https://test.invalid', isCurrent: current }
  })
  vi.mocked(readOwnedInputTask).mockResolvedValue({
    id: args.taskId,
    project_id: 'project_1',
    company_slug: 'example',
    owner_employee_id: 'emp_owner'
  })
  capture.mockResolvedValue({
    manifest: {
      source: { connectionId: null },
      deletions: [],
      files: [
        {
          id: 'file_1',
          name: 'result.txt',
          targetPath: 'reports/result.txt',
          size: bytes.length,
          sha256
        }
      ]
    },
    bytes: new Map([['file_1', bytes]])
  })
  vi.mocked(requestConsoleWorkflow).mockResolvedValue({ ok: true, data: { files: [] } })
  vi.mocked(requestConsoleWorkflowUpload).mockResolvedValue({
    ok: true,
    data: { files: [{ rel: 'uploads/result.txt', size_bytes: bytes.length, sha256 }] }
  })
})
it('captures only explicit paths and retains exact bytes under the original person', async () => {
  expect(await captureOutcomeCurrentInputs(runtime, args)).toEqual([
    {
      rel: 'uploads/result.txt',
      sha256,
      size_bytes: bytes.length,
      name: 'result.txt',
      target_path: 'reports/result.txt'
    }
  ])
  expect(capture).toHaveBeenCalledWith({
    worktree: args.worktree,
    paths: args.selectedSourcePaths,
    includeDirtyTracked: false,
    expectedConnectionId: null
  })
  expect(requestConsoleWorkflowUpload).toHaveBeenCalledWith(
    expect.any(String),
    expect.anything(),
    expect.objectContaining({ files: [expect.objectContaining({ bytes: new Uint8Array(bytes) })] }),
    120000,
    principal,
    current
  )
})
it('reuses an existing exact root file pin instead of duplicating unchanged bytes', async () => {
  vi.mocked(requestConsoleWorkflow).mockResolvedValue({
    ok: true,
    data: { files: [{ rel: 'files/already-retained.txt', size: bytes.length, sha256 }] }
  })
  expect((await captureOutcomeCurrentInputs(runtime, args))[0].rel).toBe(
    'files/already-retained.txt'
  )
  expect(requestConsoleWorkflowUpload).not.toHaveBeenCalled()
})
it('requires an explicit selection and never captures an entire folder', async () => {
  await expect(
    captureOutcomeCurrentInputs(runtime, { ...args, selectedSourcePaths: [] })
  ).rejects.toThrow()
  expect(capture).not.toHaveBeenCalled()
})
it('refuses changed captured bytes before upload', async () => {
  const snapshot = await capture()
  snapshot.bytes.set('file_1', Buffer.from('changed'))
  await expect(captureOutcomeCurrentInputs(runtime, args)).rejects.toThrow('exact manifest')
  expect(requestConsoleWorkflowUpload).not.toHaveBeenCalled()
})
it('refuses changed ownership after retention without approving a graph', async () => {
  vi.mocked(readOwnedInputTask)
    .mockResolvedValueOnce({
      id: args.taskId,
      project_id: 'project_1',
      company_slug: 'example',
      owner_employee_id: 'emp_owner'
    })
    .mockResolvedValueOnce({
      id: args.taskId,
      project_id: 'project_1',
      company_slug: 'example',
      owner_employee_id: 'emp_other'
    })
  await expect(captureOutcomeCurrentInputs(runtime, args)).rejects.toThrow('owner changed')
})
it('refuses a captured Git workspace for a current folder source', async () => {
  const snapshot = await capture()
  snapshot.manifest.baseCommit = 'b'.repeat(40)
  await expect(captureOutcomeCurrentInputs(runtime, args)).rejects.toThrow('execution host changed')
})

it('retains completed source text and Git edits with their captured HEAD and deletions', async () => {
  const snapshot = await capture()
  snapshot.manifest.baseCommit = 'b'.repeat(40)
  snapshot.manifest.deletions = ['obsolete.txt']
  vi.mocked(requestConsoleWorkflowUpload).mockImplementation(async (_url, _schema, body) => {
    const upload = body.files[0]!
    return {
      ok: true,
      data: {
        files: [
          {
            rel: `uploads/${upload.name}`,
            sha256: createHash('sha256').update(upload.bytes).digest('hex'),
            size_bytes: upload.bytes.length
          }
        ]
      }
    } as never
  })
  const summary = '# Finished\n\nCreated reports/result.txt and removed obsolete.txt.\n'
  const result = await captureOutcomeSourceInputs(runtime, {
    ...args,
    sourceResult: { path: '.omni/runs/source/source-result.md', content: summary }
  })
  expect(result.git).toEqual({ head_sha: 'b'.repeat(40), deleted_paths: ['obsolete.txt'] })
  expect(result.files.map((file) => file.target_path)).toEqual([
    'reports/result.txt',
    '.omni/runs/source/source-result.md'
  ])
  expect(result.files[1]).toMatchObject({
    size_bytes: Buffer.byteLength(summary),
    sha256: createHash('sha256').update(summary).digest('hex')
  })
  expect(capture).toHaveBeenLastCalledWith(
    expect.objectContaining({ includeDirtyTracked: true, expectedConnectionId: null })
  )
})

it('retains a response-only folder source without requiring manual file selection', async () => {
  capture.mockResolvedValue({
    manifest: { source: { connectionId: null }, files: [], deletions: [] },
    bytes: new Map()
  })
  const summary = 'The completed source answered the requested question.'
  const summaryHash = createHash('sha256').update(summary).digest('hex')
  vi.mocked(requestConsoleWorkflowUpload).mockResolvedValue({
    ok: true,
    data: {
      files: [
        {
          rel: 'uploads/source-result.md',
          sha256: summaryHash,
          size_bytes: Buffer.byteLength(summary)
        }
      ]
    }
  })
  expect(
    await captureOutcomeSourceInputs(runtime, {
      ...args,
      selectedSourcePaths: [],
      sourceResult: { path: '.omni/runs/source/source-result.md', content: summary }
    })
  ).toEqual({
    files: [
      {
        rel: 'uploads/source-result.md',
        name: 'source-result.md',
        sha256: summaryHash,
        size_bytes: Buffer.byteLength(summary),
        target_path: '.omni/runs/source/source-result.md'
      }
    ]
  })
})
