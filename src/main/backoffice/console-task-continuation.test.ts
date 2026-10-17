import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleTaskContinuationRequest } from '../../shared/console-local-execution'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { gitExecFileAsync } from '../git/runner'
import { getConsoleLocalExecution } from '../console-workflows/console-local-execution-registration'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  executionBinding,
  executionHandoff,
  executionPrincipal
} from './console-workflow-execution-test-fixture'
import { continueConsoleTask } from './console-task-continuation'
import { readConsoleTaskContinuationCapability } from './console-task-continuation-capability'

const capability = vi.hoisted(() => ({ observed: true }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getNativeLocalPtyProvider: () => ({ supportsLaunchGateObservation: () => capability.observed })
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('../console-workflows/console-local-execution-registration', () => ({
  getConsoleLocalExecution: vi.fn()
}))
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  sanitizeConsoleWorkflowText: (value: string) =>
    value.replaceAll('opaque-continuation-bearer-sentinel', '[REDACTED]'),
  redactConsoleWorkflowMemory: (value: unknown) =>
    JSON.parse(
      JSON.stringify(value).replaceAll('opaque-continuation-bearer-sentinel', '[REDACTED]')
    )
}))

const bearer = 'opaque-continuation-bearer-sentinel'
const baseUrl = 'https://console.example.test'
const fetchMock = vi.fn<typeof fetch>()
const start = vi.fn()
const showWorkspace = vi.fn()
const showRepo = vi.fn()
const runtime = {
  showManagedTerminalWorkspace: showWorkspace,
  showRepo
} as unknown as OrcaRuntimeService
let directory: string
let current: boolean
let handoffPatch: Record<string, unknown>
let afterHandoff: (() => void) | undefined
let serverCapability: unknown
let capabilityStatus: number

const request = (): ConsoleTaskContinuationRequest => ({
  operationId: 'continuation_operation_12345',
  taskId: executionBinding.taskId,
  threadId: 'hth_thread12345',
  agent: 'codex',
  model: 'gpt-6',
  effort: 'high',
  instruction: 'Continue the task using the approved handoff files.',
  worktree: 'id:folder:continuation'
})
const workspace = () => ({
  id: 'folder:continuation',
  repoId: 'folder-workspace:continuation',
  hostId: 'local',
  path: directory,
  git: { path: directory, branch: '' }
})
const person = () => ({
  bearer,
  principal: executionPrincipal,
  baseUrl,
  isCurrent: () => current
})
const admission = () => ({
  ok: true,
  job_id: executionBinding.jobId,
  workflow_id: executionBinding.workflowId,
  digest: executionHandoff().workflow.digest
})
function handoff() {
  const input = request()
  return {
    ...executionHandoff(),
    provider: input.agent,
    model: input.model,
    effort: input.effort,
    agent_brief: input.instruction,
    workspace: { kind: 'folder', path: directory },
    repo: null,
    base_branch: null,
    base_sha: null,
    acceptance_commands: [],
    ...handoffPatch
  }
}
const reply = (value: unknown) => new Response(JSON.stringify(value))
const continueTask = (input = request()) => continueConsoleTask(runtime, input)

function useGitWorkspace() {
  const git = {
    origin: 'https://gitlab.example/team/project.git',
    branch: 'feature/task-continuation',
    sha: 'c'.repeat(40)
  }
  showWorkspace.mockResolvedValue({ ...workspace(), id: 'git-worktree', repoId: 'repo-git' })
  showRepo.mockResolvedValue({
    id: 'repo-git',
    kind: 'git',
    path: directory,
    executionHostId: 'local'
  })
  vi.mocked(gitExecFileAsync).mockImplementation(async (args) => {
    const command = args.join(' ')
    const value =
      command === 'remote get-url origin'
        ? git.origin
        : command === 'symbolic-ref --quiet --short HEAD'
          ? git.branch
          : command === 'rev-parse --verify HEAD'
            ? git.sha
            : undefined
    if (value === undefined) {
      throw new Error(`Unexpected Git command ${command}`)
    }
    return { stdout: `${value}\n`, stderr: '' }
  })
  handoffPatch = {
    workspace: undefined,
    repo: git.origin,
    base_branch: git.branch,
    base_sha: git.sha
  }
  return git
}

beforeEach(async () => {
  vi.resetAllMocks()
  capability.observed = true
  directory = await realpath(await mkdtemp(join(tmpdir(), 'console-continuation-')))
  current = true
  handoffPatch = {}
  afterHandoff = undefined
  serverCapability = { ok: true, task_continuation: { available: true } }
  capabilityStatus = 200
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(captureConsoleWorkflowPerson).mockImplementation(async () => ({
    ok: true,
    data: person()
  }))
  showWorkspace.mockImplementation(async () => workspace())
  showRepo.mockRejectedValue(new Error('Native folders have no repository record.'))
  vi.mocked(getConsoleLocalExecution).mockReturnValue({ start } as never)
  start.mockResolvedValue({
    ok: true,
    data: {
      jobId: executionBinding.jobId,
      workflowId: executionBinding.workflowId,
      cardId: executionBinding.taskId,
      runId: 'run_continuation',
      dispatchId: 'dispatch_continuation',
      terminalHandle: 'terminal_continuation',
      worktreeId: 'folder:continuation',
      branch: null,
      state: 'running'
    }
  })
  fetchMock.mockImplementation(async (url) => {
    if (new URL(String(url)).pathname === '/api/gtd/task-continuation/capabilities') {
      return Response.json(serverCapability, { status: capabilityStatus })
    }
    if (String(url).endsWith('/continue')) {
      return reply(admission())
    }
    if (String(url).endsWith('/handoff')) {
      const body = { ok: true, handoff: handoff(), workflow_inputs: [], blockers: [], ready: true }
      afterHandoff?.()
      return reply(body)
    }
    throw new Error(`Unexpected continuation route ${String(url)}`)
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('signed task continuation admission', () => {
  it.each(['Assign this task before continuing.', 'Only the current task owner can continue.'])(
    'preserves task-scoped ownership refusal before any write: %s',
    async (reason) => {
      serverCapability = { ok: true, task_continuation: { available: false, reason } }
      expect(await continueTask()).toMatchObject({
        ok: false,
        error: { code: 'capability_unavailable', message: reason }
      })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${baseUrl}/api/gtd/task-continuation/capabilities?task_id=${request().taskId}`
      )
      expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
      expect(start).not.toHaveBeenCalled()
    }
  )

  it('rejects a malformed capability task before credentials or HTTP', async () => {
    expect(
      await readConsoleTaskContinuationCapability({ taskId: '../another-task' })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the server rollback switch without attempting admission', async () => {
    serverCapability = {
      ok: true,
      task_continuation: { available: false, reason: 'Task continuation is temporarily disabled.' }
    }
    expect(await readConsoleTaskContinuationCapability()).toEqual({
      ok: true,
      data: { available: false, reason: 'Task continuation is temporarily disabled.' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(showWorkspace).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it.each([
    { status: 404, body: { detail: 'Not found' }, code: 'capability_unavailable' },
    { status: 200, body: { ok: true }, code: 'invalid_response' },
    {
      status: 200,
      body: { ok: true, task_continuation: { available: 'true' } },
      code: 'invalid_response'
    },
    {
      status: 200,
      body: { ok: true, task_continuation: { available: false } },
      code: 'capability_unavailable'
    }
  ])('refuses an absent or disabled negotiated capability: $status $code', async (entry) => {
    serverCapability = entry.body
    capabilityStatus = entry.status
    expect(await continueTask()).toMatchObject({ ok: false, error: { code: entry.code } })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
    expect(start).not.toHaveBeenCalled()
  })

  it('rechecks the capability for each retry instead of retaining a former grant', async () => {
    expect(await continueTask()).toMatchObject({ ok: true })
    serverCapability = { ok: true, task_continuation: { available: false } }
    expect(await continueTask()).toMatchObject({
      ok: false,
      launchDisposition: 'not-started',
      error: { code: 'capability_unavailable' }
    })
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(start).toHaveBeenCalledOnce()
  })

  it('refuses an unsupported process observer before credentials or task admission', async () => {
    capability.observed = false
    expect(await continueTask()).toMatchObject({
      ok: false,
      launchDisposition: 'not-started',
      error: { code: 'capability_unavailable' }
    })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(showWorkspace).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('posts exactly the selected contract and starts only its frozen named job', async () => {
    const answer = await continueTask()
    expect(answer).toMatchObject({ ok: true, data: { cardId: request().taskId, branch: null } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0]).toEqual([
      `${baseUrl}/api/gtd/task-continuation/capabilities?task_id=${request().taskId}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: `Bearer ${bearer}` })
      })
    ])
    const [url, options] = fetchMock.mock.calls[1]
    expect(url).toBe(`${baseUrl}/api/gtd/workflow-tasks/${request().taskId}/continue`)
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${bearer}` }
    })
    expect(JSON.parse(options!.body as string)).toEqual({
      operation_id: request().operationId,
      thread_id: request().threadId,
      provider: request().agent,
      model: request().model,
      effort: request().effort,
      instruction: request().instruction,
      workspace: { kind: 'folder', path: directory, host: 'local' }
    })
    expect(fetchMock.mock.calls[2][0]).toBe(
      `${baseUrl}/api/gtd/workflow-jobs/${executionBinding.jobId}/handoff`
    )
    expect(start).toHaveBeenCalledExactlyOnceWith({
      jobId: executionBinding.jobId,
      workflowId: executionBinding.workflowId,
      approvedDigest: admission().digest,
      worktree: request().worktree
    })
    expect(showRepo).not.toHaveBeenCalled()
    expect(gitExecFileAsync).not.toHaveBeenCalled()
    expect(options!.body).not.toContain(bearer)
    expect(JSON.stringify(answer)).not.toContain(bearer)
  })

  it('preserves the same caller operation id on an explicit retry', async () => {
    await continueTask()
    await continueTask()
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts.map(([, options]) => JSON.parse(options!.body as string).operation_id)).toEqual([
      request().operationId,
      request().operationId
    ])
  })

  it('forwards the explicitly selected server goal without changing the continuation identity', async () => {
    const input = { ...request(), goalId: 'cgl_actual' }
    expect(await continueTask(input)).toMatchObject({ ok: true })
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toMatchObject({
      goal_id: input.goalId,
      operation_id: input.operationId
    })
    expect(start).toHaveBeenCalledOnce()
  })

  it('returns the signed goal setup choices to the renderer without starting an agent', async () => {
    const setup = {
      gaps: ['task_goal_missing'],
      company_id: 'co_x',
      goals: [
        {
          id: 'cgl_actual',
          title: 'Actual outcome',
          org_unit_id: null,
          horizon: 'long_term',
          status: 'active'
        }
      ],
      action_url: '/work/tasks/btk_input12345'
    }
    fetchMock.mockResolvedValueOnce(reply(serverCapability)).mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error: { code: 'task_setup_required', message: 'Choose a goal for this task.', ...setup }
        },
        { status: 422 }
      )
    )
    expect(await continueTask()).toEqual({
      ok: false,
      launchDisposition: 'unverifiable',
      error: {
        code: 'task_setup_required',
        message: 'Choose a goal for this task.',
        status: 422,
        taskSetup: setup
      }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getConsoleLocalExecution).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects a malformed explicit goal before credentials or network', async () => {
    expect(await continueTask({ ...request(), goalId: '../another-goal' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('preserves leading and trailing instruction whitespace through admission and handoff validation', async () => {
    const instruction = `\n  ${request().instruction}  \n`
    handoffPatch.agent_brief = instruction
    expect(await continueTask({ ...request(), instruction })).toMatchObject({ ok: true })
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).instruction).toBe(instruction)
    expect(start).toHaveBeenCalledOnce()
  })

  it.each([
    ['provider', { provider: 'claude' }],
    ['model', { model: 'different-model' }],
    ['effort', { effort: 'low' }],
    ['instruction', { agent_brief: 'A different instruction.' }],
    [
      'task',
      {
        task_id: 'btk_another1234',
        canonical_binding: {
          ...executionHandoff().canonical_binding,
          task_id: 'btk_another1234'
        }
      }
    ],
    ['workspace', { workspace: { kind: 'folder', path: '/another-folder' } }],
    ['placement', { placement: 'fleet' }],
    ['workflow', { workflow: { ...executionHandoff().workflow, workflow_id: 'wf_another1234' } }],
    ['digest', { workflow: { ...executionHandoff().workflow, digest: 'e'.repeat(64) } }]
  ])('refuses a changed admitted %s before local start', async (_field, patch) => {
    handoffPatch = patch as Record<string, unknown>
    expect(await continueTask()).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
    expect(start).not.toHaveBeenCalled()
    expect(getConsoleLocalExecution).not.toHaveBeenCalled()
  })

  it('refuses an account changed before API admission', async () => {
    vi.mocked(captureConsoleWorkflowPerson)
      .mockResolvedValueOnce({ ok: true, data: person() })
      .mockResolvedValueOnce({ ok: true, data: { ...person(), principal: 'b'.repeat(64) } })
    expect(await continueTask()).toMatchObject({ ok: false, error: { code: 'principal_mismatch' } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses an account changed while reading the admitted handoff', async () => {
    afterHandoff = () => {
      current = false
    }
    expect(await continueTask()).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
    expect(start).not.toHaveBeenCalled()
  })

  it('rechecks the account after the final workspace resolution await', async () => {
    showWorkspace.mockResolvedValueOnce(workspace()).mockImplementationOnce(async () => {
      await Promise.resolve()
      current = false
      return workspace()
    })
    expect(await continueTask()).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a selected folder changed before activation', async () => {
    const changed = join(directory, 'other')
    await mkdir(changed)
    afterHandoff = () => showWorkspace.mockResolvedValue({ ...workspace(), path: changed })
    expect(await continueTask()).toMatchObject({ ok: false, error: { code: 'connection_changed' } })
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a remote workspace before API admission or local path access', async () => {
    showWorkspace.mockResolvedValue({
      ...workspace(),
      hostId: 'ssh:execution-host',
      path: '/not-on-this-host'
    })
    expect(await continueTask()).toMatchObject({
      ok: false,
      error: { code: 'task_continuation_refused' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(showRepo).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a folder workspace replaced by a file before API admission', async () => {
    const path = join(directory, 'not-a-directory')
    await writeFile(path, 'not a folder')
    showWorkspace.mockResolvedValue({ ...workspace(), path })
    expect(await continueTask()).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a legacy repo-backed folder before admitting an unstartable native folder job', async () => {
    showWorkspace.mockResolvedValue({ ...workspace(), id: 'legacy-folder', repoId: 'legacy-repo' })
    showRepo.mockResolvedValue({ id: 'legacy-repo', kind: 'folder', path: directory })
    expect(await continueTask()).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it.each([
    { taskId: '../another-task' },
    { operationId: 'short' },
    { instruction: '' },
    { model: '' },
    { unsupported: true },
    { effort: 'unsupported-effort' }
  ])('rejects invalid input before reading credentials: %j', async (patch) => {
    expect(await continueTask({ ...request(), ...patch })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(showWorkspace).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'preserves the Git origin host identity (mismatch=%s)',
    async (mismatch) => {
      const git = useGitWorkspace()
      if (mismatch) {
        handoffPatch.repo = 'https://github.com/team/project.git'
      }
      expect((await continueTask()).ok).toBe(!mismatch)
      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string)
      expect(body.workspace).toEqual({
        kind: 'git',
        path: directory,
        host: 'local',
        repo: git.origin,
        base_branch: git.branch,
        base_sha: git.sha
      })
      if (mismatch) {
        expect(start).not.toHaveBeenCalled()
      } else {
        expect(start).toHaveBeenCalledOnce()
      }
    }
  )

  it.each([{ base_branch: 'main' }, { base_sha: 'd'.repeat(40) }])(
    'refuses a handoff that changes the selected Git base: %j',
    async (patch) => {
      useGitWorkspace()
      handoffPatch = { ...handoffPatch, ...patch }
      expect(await continueTask()).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
      expect(start).not.toHaveBeenCalled()
    }
  )

  it.each([
    { host: 'github.com', accepted: true },
    { host: 'gitlab.com', accepted: false }
  ])(
    'matches a Foreman owner/repo handoff to its actual $host origin',
    async ({ host, accepted }) => {
      const git = useGitWorkspace()
      git.origin = `https://${host}/omnirogue/omni-ide.git`
      handoffPatch.repo = 'omnirogue/omni-ide'
      const result = await continueTask()
      expect(result.ok).toBe(accepted)
      const body = JSON.parse(fetchMock.mock.calls[1][1]!.body as string)
      expect(body.workspace).toMatchObject({
        repo: git.origin,
        base_branch: git.branch,
        base_sha: git.sha
      })
      if (accepted) {
        expect(start).toHaveBeenCalledOnce()
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
        expect(start).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['branch', 'sha'] as const)(
    'refuses a Git %s changed before activation',
    async (field) => {
      const git = useGitWorkspace()
      afterHandoff = () => {
        git[field] = field === 'branch' ? 'another-branch' : 'd'.repeat(40)
      }
      expect(await continueTask()).toMatchObject({
        ok: false,
        error: { code: 'connection_changed' }
      })
      expect(start).not.toHaveBeenCalled()
    }
  )

  it.each([{ branch: '' }, { sha: 'unverifiable' }])(
    'refuses an unnamed or unverifiable Git base before admission: %j',
    async (patch) => {
      Object.assign(useGitWorkspace(), patch)
      expect(await continueTask()).toMatchObject({ ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
    }
  )
})
