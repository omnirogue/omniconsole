import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import type { ConsoleLocalJob } from '../console-workflows/console-local-execution-contract'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { prepareConsoleTaskInputs } from './console-task-inputs'
import { readConsoleWorkflowHandoff } from './console-workflow-handoff'
vi.mock('./console-workflow-handoff', () => ({ readConsoleWorkflowHandoff: vi.fn() }))

const profile = vi.hoisted(() => ({ directory: '' }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => profile.directory
}))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

const principal = 'a'.repeat(64)
const bearer = 'opaque-input-download-sentinel'
const bytes = Buffer.from('The exact approved input.\n')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const fetchMock = vi.fn<typeof fetch>()
const isCurrent = vi.fn(() => true)
const taskFile = () => ({
  kind: 'task_file' as const,
  task_id: 'btk_input12345',
  file: { rel: 'files/approved.txt', sha256, size_bytes: bytes.length, name: 'approved.txt' }
})
const handoffFile = () => ({
  kind: 'handoff_file' as const,
  thread_id: 'hth_input12345',
  file: {
    id: 'hfv_input12345',
    path: 'files/approved.txt',
    name: 'approved.txt',
    sha256,
    size: bytes.length,
    version: 1,
    parent_version_id: null,
    current: false,
    available: true
  }
})
const job = (inputs: unknown[] = [taskFile()]): ConsoleLocalJob => ({
  id: 'job_input12345',
  taskId: 'btk_input12345',
  workflowId: 'wf_input12345',
  digest: 'b'.repeat(64),
  state: 'running',
  placement: 'local',
  provider: 'codex',
  model: 'gpt-6',
  title: 'Prepare approved task inputs',
  workspace: { kind: 'folder', path: profile.directory },
  repo: null,
  baseSha: null,
  baseBranch: null,
  prompt: 'Use the pinned task inputs.',
  brief: 'Use the pinned task inputs.',
  acceptance: 'Report actual work evidence.',
  acceptanceCommands: [],
  inputs,
  ownedPaths: null,
  readOnly: true
})
const retainedDirectory = () => join(profile.directory, 'console-task-inputs', principal, job().id)
const retainedFile = () => join(retainedDirectory(), `${sha256}-approved.txt`)
const person = () => ({
  bearer,
  principal,
  baseUrl: 'https://console.example.test',
  isCurrent
})

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(readConsoleWorkflowHandoff).mockResolvedValue({
    ok: false,
    error: { code: 'unavailable', message: 'No signed parent source.' }
  })
  profile.directory = await realpath(await mkdtemp(join(tmpdir(), 'console-task-inputs-')))
  isCurrent.mockReturnValue(true)
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockImplementation(async () => ({
    ok: true,
    data: person()
  }))
  fetchMock.mockImplementation(async () => new Response(bytes))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(profile.directory, { recursive: true, force: true })
})

describe('materializing exact admitted task inputs', () => {
  it('downloads pinned task and handoff versions to private readable files without rewriting inputs', async () => {
    const input = job([taskFile(), handoffFile(), { kind: 'note', body: 'Context only' }])
    const frozenInputs = JSON.stringify(input.inputs)
    const paths = await prepareConsoleTaskInputs(input)
    expect(paths).toEqual([
      retainedFile(),
      join(
        retainedDirectory(),
        `${createHash('sha256').update('hfv_input12345').digest('hex')}-approved.txt`
      )
    ])
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://console.example.test/api/gtd/hub/api/board/btk_input12345/files/download?path=files%2Fapproved.txt',
      'https://console.example.test/api/gtd/hub/api/handoffs/hth_input12345/files/hfv_input12345'
    ])
    for (const path of paths) {
      expect(await readFile(path)).toEqual(bytes)
      expect((await lstat(path)).isSymbolicLink()).toBe(false)
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o400)
      }
    }
    if (process.platform !== 'win32') {
      expect((await stat(retainedDirectory())).mode & 0o777).toBe(0o700)
    }
    expect(JSON.stringify(input.inputs)).toBe(frozenInputs)
    expect(JSON.stringify(paths)).not.toContain(bearer)
  })

  it('reuses identical retained bytes on an explicit retry', async () => {
    const first = await prepareConsoleTaskInputs(job())
    const before = await stat(first[0])
    expect(await prepareConsoleTaskInputs(job())).toEqual(first)
    expect((await stat(first[0])).ino).toBe(before.ino)
    expect(await readFile(first[0])).toEqual(bytes)
    expect(await readdir(retainedDirectory())).toEqual([`${sha256}-approved.txt`])
  })

  it('retains a long Unicode filename within the filesystem byte limit', async () => {
    const name = `${'😀'.repeat(100)}.txt`
    const paths = await prepareConsoleTaskInputs(
      job([{ ...taskFile(), file: { ...taskFile().file, name } }])
    )
    expect(paths).toHaveLength(1)
    expect(Buffer.byteLength(basename(paths[0]), 'utf8')).toBeLessThanOrEqual(225)
    expect(await readFile(paths[0])).toEqual(bytes)
  })

  it('refuses an unsealed different-task input before file download', async () => {
    const input = { ...taskFile(), task_id: 'btk_other12345' }
    await expect(prepareConsoleTaskInputs(job([input]))).rejects.toThrow('different task')
    expect(readConsoleWorkflowHandoff).toHaveBeenCalledWith(job().id, principal)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readdir(profile.directory)).toEqual([])
  })

  it.each([
    { rel: '../private.txt' },
    { rel: '/private.txt' },
    { rel: 'files\\private.txt' },
    { rel: 'files/\0private.txt' },
    { rel: 'files//private.txt' },
    { rel: 'files/private.txt/' },
    { sha256: 'not-a-digest' },
    { size_bytes: -1 },
    { size_bytes: HANDOFF_FILE_MAX_BYTES + 1 },
    { name: '../private.txt' },
    { name: 'private\0.txt' }
  ])(
    'refuses a malformed pinned task reference before credentials or network: %j',
    async (patch) => {
      await expect(
        prepareConsoleTaskInputs(job([{ ...taskFile(), file: { ...taskFile().file, ...patch } }]))
      ).rejects.toThrow()
      expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await readdir(profile.directory)).toEqual([])
    }
  )

  it('refuses malformed handoff references before credentials or network', async () => {
    await expect(
      prepareConsoleTaskInputs(job([{ ...handoffFile(), thread_id: '../another-thread' }]))
    ).rejects.toThrow()
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not capture a person or create directories for informational inputs only', async () => {
    expect(await prepareConsoleTaskInputs(job(['Context only', { kind: 'note' }]))).toEqual([])
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readdir(profile.directory)).toEqual([])
  })

  it('refuses input reads after the captured person changes', async () => {
    isCurrent.mockReturnValue(false)
    await expect(prepareConsoleTaskInputs(job())).rejects.toThrow('person changed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['task_file', 'handoff_file'])(
    'pins the original person across the nested %s download capture',
    async (kind) => {
      vi.mocked(captureConsoleWorkflowPerson)
        .mockResolvedValueOnce({ ok: true, data: person() })
        .mockResolvedValueOnce({ ok: true, data: { ...person(), principal: 'b'.repeat(64) } })
      await expect(
        prepareConsoleTaskInputs(job([kind === 'task_file' ? taskFile() : handoffFile()]))
      ).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await readdir(retainedDirectory())).toEqual([])
    }
  )

  it('does not save bytes when the person changes during download', async () => {
    fetchMock.mockImplementationOnce(async () => {
      isCurrent.mockReturnValue(false)
      return new Response(bytes)
    })
    await expect(prepareConsoleTaskInputs(job())).rejects.toThrow()
    expect(await readdir(retainedDirectory())).toEqual([])
  })

  it.each(['digest', 'size'])(
    'rejects received bytes that do not match the pinned %s',
    async (kind) => {
      const changed =
        kind === 'size' ? Buffer.concat([bytes, Buffer.from('!')]) : Buffer.alloc(bytes.length, 65)
      fetchMock.mockResolvedValueOnce(new Response(changed))
      await expect(prepareConsoleTaskInputs(job())).rejects.toThrow('exact version')
      expect(await readdir(retainedDirectory())).toEqual([])
    }
  )

  it('refuses an existing symlink at the private input root before downloading', async () => {
    const target = join(profile.directory, 'outside')
    await mkdir(target, { mode: 0o700 })
    await symlink(
      target,
      join(profile.directory, 'console-task-inputs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(prepareConsoleTaskInputs(job())).rejects.toThrow('private local directory')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readdir(target)).toEqual([])
  })

  it('refuses a retained symlink without touching its target', async () => {
    await mkdir(retainedDirectory(), { recursive: true, mode: 0o700 })
    const target = join(profile.directory, 'outside.txt')
    await writeFile(target, bytes)
    await symlink(target, retainedFile(), 'file')
    await expect(prepareConsoleTaskInputs(job())).rejects.toThrow('retained task input')
    expect(await readFile(target)).toEqual(bytes)
    expect((await lstat(retainedFile())).isSymbolicLink()).toBe(true)
  })

  it('refuses a changed retained file instead of overwriting it during retry', async () => {
    await mkdir(retainedDirectory(), { recursive: true, mode: 0o700 })
    const changed = Buffer.alloc(bytes.length, 65)
    await writeFile(retainedFile(), changed, { mode: 0o400 })
    await expect(prepareConsoleTaskInputs(job())).rejects.toThrow('retained task input')
    expect(await readFile(retainedFile())).toEqual(changed)
  })
})

it.each([false, true])(
  'hydrates exact signed parent files and rechecks ownership after download (changed=%s)',
  async (changed) => {
    const rootTask = 'btk_parent12345'
    const input = { ...taskFile(), task_id: rootTask, target_path: 'reports/approved.txt' }
    const admitted = job([input])
    vi.mocked(readConsoleWorkflowHandoff).mockResolvedValue({ ok: true, data: admitted })
    let downloaded = false
    fetchMock.mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/files/download')) {
        downloaded = true
        return new Response(bytes)
      }
      if (path === '/api/me') {
        return Response.json({ ok: true, mode: 'clerk', user: { employee_id: 'emp_owner' } })
      }
      return Response.json({
        id: path.endsWith(rootTask) ? rootTask : admitted.taskId,
        parent_task_id: path.endsWith(rootTask) ? null : rootTask,
        project_id: 'project_1',
        company_slug: 'example',
        owner_employee_id: changed && downloaded ? 'emp_other' : 'emp_owner'
      })
    })
    if (changed) {
      await expect(prepareConsoleTaskInputs(admitted)).rejects.toThrow('authority changed')
    } else {
      const paths = await prepareConsoleTaskInputs(admitted)
      expect(paths).toHaveLength(1)
      expect(await readFile(paths[0])).toEqual(bytes)
      expect(input.target_path).toBe('reports/approved.txt')
      expect(readConsoleWorkflowHandoff).toHaveBeenCalledTimes(2)
    }
  }
)
