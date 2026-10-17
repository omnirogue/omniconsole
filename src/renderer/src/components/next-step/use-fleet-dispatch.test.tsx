// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CapturedConversationFleetContext,
  readConversationFleetContext
} from '@/lib/conversation-fleet-context'
import type {
  PreparedConversationFleetInputs,
  prepareConversationFleetInputs
} from '@/lib/conversation-fleet-inputs'
import type { pauseConversationAfterFleetDispatch } from '@/lib/conversation-fleet-pause'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  workflowJobFixture,
  workflowPreviewFixture
} from '@/components/console-workflows/console-workflow-test-fixtures'
import type {
  ConsoleConversationFleetInventory,
  ConsoleConversationFleetPreview
} from '../../../../shared/console-conversation-fleet-types'
import type {
  ConsoleWorkflowApi,
  ConsoleWorkflowAdmission
} from '../../../../shared/console-workflow-types'
import type { buildConversationFleetWorkflow } from '../../../../shared/conversation-fleet-workflow'
import { emptyNextStepDraft, type NextStepDraft } from '../../../../shared/next-step-draft'
import type { FleetDispatchReview } from './fleet-dispatch-types'
import { useFleetDispatch } from './use-fleet-dispatch'

const mocks = vi.hoisted(() => ({
  scope: 'person-a',
  api: {
    fleetInventory: vi.fn<ConsoleWorkflowApi['fleetInventory']>(),
    fleetTaskContext: vi.fn<ConsoleWorkflowApi['fleetTaskContext']>(),
    previewFleetTask: vi.fn<ConsoleWorkflowApi['previewFleetTask']>(),
    admitFleetTask: vi.fn<ConsoleWorkflowApi['admitFleetTask']>()
  },
  capture: vi.fn<typeof readConversationFleetContext>(),
  upload: vi.fn<typeof prepareConversationFleetInputs>(),
  compile: vi.fn<typeof buildConversationFleetWorkflow>(),
  pause: vi.fn<typeof pauseConversationAfterFleetDispatch>(),
  store: { load: vi.fn(), beginAdmission: vi.fn(), remember: vi.fn(), recordJobs: vi.fn() },
  toast: { success: vi.fn(), warning: vi.fn() },
  app: {
    settings: {},
    getKnownWorktreeById: vi.fn(() => ({ repoId: 'repo-source', path: '/source', branch: 'work' })),
    repos: [
      {
        id: 'repo-source',
        kind: 'git',
        gitRemoteIdentity: { remoteUrl: 'git@github.com:Example/project.git' }
      }
    ]
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof mocks.app) => T) => selector(mocks.app),
    {
      getState: () => mocks.app
    }
  )
}))
vi.mock('@/store/conversation-fleet-store', () => ({
  conversationFleetScope: () => mocks.scope,
  useConversationFleetStore: { getState: () => mocks.store }
}))
vi.mock('@/lib/conversation-fleet-context', () => ({ readConversationFleetContext: mocks.capture }))
vi.mock('@/lib/conversation-fleet-inputs', () => ({ prepareConversationFleetInputs: mocks.upload }))
vi.mock('@/lib/conversation-fleet-pause', () => ({
  pauseConversationAfterFleetDispatch: mocks.pause
}))
vi.mock('@/lib/conversation-fleet-inventory', () => ({ conversationFleetAgents: () => [] }))
vi.mock('../../../../shared/conversation-fleet-workflow', () => ({
  buildConversationFleetWorkflow: mocks.compile
}))
vi.mock('./use-next-step-recipients', () => ({
  useNextStepPeople: () => ({ people: { phase: 'ready', value: [] } })
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const originalApi = window.api
const session: SidebarSession = {
  rowKey: 'source-row',
  sessionKey: 'source-session',
  worktreeId: 'worktree-source',
  hostId: 'ssh:source-mac',
  tabId: 'tab-source',
  paneKey: 'tab-source:leaf',
  kind: 'terminal',
  label: 'Review search',
  workspaceLabel: 'Search',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
const captured: CapturedConversationFleetContext = {
  title: session.label,
  sourceSessionId: 'provider-source',
  sourceWorkspacePath: '/source',
  sourceHostId: 'ssh:source-mac',
  sourceAgent: 'codex',
  sourceKind: 'provider',
  sourceContextWarnings: ['One source tool payload is retained as a digest.'],
  sourceRawTranscript: '{"role":"user","content":"Review all history"}\n',
  sourceRawFormat: 'provider-jsonl',
  transcript: 'The complete readable conversation.'
}
const inventory: ConsoleConversationFleetInventory = {
  providers: ['codex'],
  models: [
    {
      id: 'codex:test-model',
      provider: 'codex',
      model: 'test-model',
      supported_efforts: ['high'],
      default: true,
      seat_ready: true,
      aliases: []
    }
  ],
  people: [],
  repositories: [{ id: 'Example/project' }],
  models_fallback: false,
  machines: [
    {
      host: 'fleet-mac',
      allowed: true,
      ready: true,
      last_beat: '2026-09-12T16:00:00Z',
      slots: 2,
      running: 0,
      execution_capabilities: [
        {
          provider: 'codex',
          available: true,
          models: ['test-model'],
          efforts: ['high'],
          resume: true,
          readonly: true,
          native_execution: true,
          pinned_task_inputs: true,
          source_snapshot: true,
          folder_workspace: true,
          account_usage: {
            version: 1,
            selected_account_ref: '11111111-1111-4111-8111-111111111111',
            account_generation: '22222222-2222-4222-8222-222222222222',
            usage: {
              provider: 'codex',
              status: 'ok',
              updatedAt: Date.now(),
              error: null,
              session: {
                usedPercent: 10,
                windowMinutes: 300,
                resetsAt: null,
                resetDescription: null
              },
              weekly: null
            }
          }
        }
      ]
    }
  ]
}
const filing = { company_slug: 'omni', org_unit_id: 'ou_dev', goal_id: 'goal_search' }
let inputs: PreparedConversationFleetInputs
let preview: ConsoleConversationFleetPreview
let admitted: ConsoleWorkflowAdmission
let draft: NextStepDraft

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  mocks.scope = 'person-a'
  mocks.app.getKnownWorktreeById.mockReturnValue({
    repoId: 'repo-source',
    path: '/source',
    branch: 'work'
  })
  mocks.store.beginAdmission.mockReturnValue(true)
  mocks.store.remember.mockReturnValue(true)
  Object.assign(window, { api: { consoleWorkflows: mocks.api } })
  inputs = {
    context: {
      title: captured.title,
      sourceSessionId: captured.sourceSessionId,
      sourceWorkspacePath: '/source',
      transcript: 'Read exact frozen input conversation.md.'
    },
    sourceFiles: [
      {
        kind: 'task_file',
        task_id: 'btk_test1234',
        file: {
          rel: 'files/conversation.md',
          name: 'conversation.md',
          sha256: 'b'.repeat(64),
          size_bytes: 41
        }
      }
    ],
    sourceDeletions: ['obsolete.txt'],
    baseCommit: 'c'.repeat(40),
    branch: 'refs/heads/work',
    remoteUrl: 'https://github.com/Example/project.git',
    transcriptDigest: 'd'.repeat(64),
    warnings: [...captured.sourceContextWarnings]
  }
  preview = {
    ...workflowPreviewFixture(),
    admission: {
      task_id: 'btk_test1234',
      expected_revision: 12,
      context_digest: 'e'.repeat(64),
      adopt_stage: 'build'
    },
    filing,
    reviewer: { provider: 'codex', model: 'test-model', effort: 'high' }
  }
  preview.graph.nodes = preview.graph.nodes.map((node) => ({
    ...node,
    placement: 'fleet',
    machine: 'fleet-mac'
  }))
  const job = workflowJobFixture()
  job.policy.workflow = {
    ...job.policy.workflow,
    placement: 'fleet',
    source: { session_ref: session.rowKey, session_id: session.sessionKey },
    machine: 'fleet-mac'
  }
  admitted = { workflow_id: preview.workflow_id, jobs: [job], receipt: { admitted: true } }
  draft = {
    ...emptyNextStepDraft(),
    recipients: [
      {
        kind: 'agent',
        key: 'review',
        agent: 'codex',
        model: 'test-model',
        effort: 'high',
        presetId: 'review',
        instructions: 'Review search.',
        rounds: 1
      }
    ],
    handoff: {
      task: { id: 'btk_test1234', title: 'Search' },
      deliverables: null,
      includeSummary: true
    }
  }
  mocks.api.fleetInventory.mockResolvedValue({ ok: true, data: inventory })
  mocks.api.fleetTaskContext
    .mockResolvedValueOnce({
      ok: true,
      data: { ok: true, task_id: 'btk_test1234', expected_revision: 10, supported: true, filing }
    })
    .mockResolvedValue({
      ok: true,
      data: { ok: true, task_id: 'btk_test1234', expected_revision: 12, supported: true, filing }
    })
  mocks.api.previewFleetTask.mockResolvedValue({ ok: true, data: preview })
  mocks.api.admitFleetTask.mockResolvedValue({ ok: true, data: admitted })
  mocks.capture.mockResolvedValue(captured)
  mocks.upload.mockResolvedValue(inputs)
  mocks.compile.mockReturnValue({
    classification: { title: 'Review search', company_slug: 'omni', steps: [] },
    prompt: 'The exact compiled prompt.',
    sourceSessionId: captured.sourceSessionId
  })
  mocks.pause.mockResolvedValue({ state: 'paused', message: 'Source paused.' })
})

afterEach(() => {
  cleanup()
  Object.assign(window, { api: originalApi })
})

async function preparedHook() {
  const hook = renderHook(() => useFleetDispatch({ kind: 'session', session }))
  await waitFor(() => expect(hook.result.current.machines.phase).toBe('ready'))
  let review!: FleetDispatchReview
  await act(async () => {
    review = await hook.result.current.onPrepare(draft, 'fleet-mac', true)
  })
  return { ...hook, review }
}

describe('useFleetDispatch', () => {
  it('explains missing agent readiness while keeping people and inventory available', async () => {
    const hook = renderHook(() => useFleetDispatch({ kind: 'session', session }))
    await waitFor(() => expect(hook.result.current.machines.phase).toBe('ready'))

    expect(hook.result.current.recipients.agents).toEqual({
      phase: 'error',
      message:
        'Fleet agent sign-in and usage could not be verified. Refresh or choose an available agent in this conversation.'
    })
    expect(hook.result.current.recipients.people.phase).toBe('ready')
    await act(async () => {
      expect(await hook.result.current.recipients.refreshAgents()).toEqual([])
    })
    expect(mocks.api.fleetInventory).toHaveBeenCalledTimes(2)
    expect(mocks.api.previewFleetTask).not.toHaveBeenCalled()
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
  })

  it('captures on the source host, uploads all context, then previews with the post-upload task revision', async () => {
    const preparationStartedAt = Date.now()
    const { review } = await preparedHook()
    const preparationFinishedAt = Date.now()
    expect(mocks.capture).toHaveBeenCalledWith(session, expect.any(AbortSignal))
    expect(mocks.app.getKnownWorktreeById).toHaveBeenCalledWith(
      session.worktreeId,
      captured.sourceHostId
    )
    expect(mocks.upload).toHaveBeenCalledWith({
      taskId: 'btk_test1234',
      session,
      context: captured,
      selection: { paths: [], includeDirtyTracked: true },
      capturedAt: expect.any(String),
      signal: expect.any(AbortSignal)
    })
    expect(mocks.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        context: inputs.context,
        repo: 'Example/project',
        baseBranch: 'work',
        baseCommit: inputs.baseCommit,
        machine: 'fleet-mac'
      })
    )
    expect(mocks.api.previewFleetTask).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 12,
        fanoutAck: true,
        sourceFiles: inputs.sourceFiles,
        sourceDeletions: inputs.sourceDeletions,
        source: {
          sessionRef: session.rowKey,
          sessionId: session.sessionKey,
          transcriptDigest: inputs.transcriptDigest,
          capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        }
      })
    )
    const capturedAt = Date.parse(
      mocks.api.previewFleetTask.mock.calls[0]![0].source.capturedAt ?? ''
    )
    expect(capturedAt).toBeGreaterThanOrEqual(preparationStartedAt)
    expect(capturedAt).toBeLessThanOrEqual(preparationFinishedAt)
    expect(mocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.upload.mock.invocationCallOrder[0]!
    )
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.api.fleetTaskContext.mock.invocationCallOrder[1]!
    )
    expect(mocks.api.fleetTaskContext.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.api.previewFleetTask.mock.invocationCallOrder[0]!
    )
    expect(review.inputs).toEqual([{ name: 'conversation.md', sizeBytes: 41 }])
    expect(review.warnings).toEqual(inputs.warnings)
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
  })

  it('requires the exact review reference and persists the pending identity before admission starts', async () => {
    const { result, review } = await preparedHook()
    const capturedAt = mocks.api.previewFleetTask.mock.calls[0]![0].source.capturedAt
    expect(capturedAt).toEqual(expect.any(String))
    await expect(result.current.onDispatch({ ...review })).rejects.toThrow(
      /reviewed dispatch changed/i
    )
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.onDispatch(review)
    })
    expect(mocks.store.beginAdmission).toHaveBeenCalledWith(
      'person-a',
      expect.objectContaining({
        workflowId: preview.workflow_id,
        taskId: 'btk_test1234',
        digest: preview.digest,
        rowKey: session.rowKey,
        sessionKey: session.sessionKey,
        capturedAt
      })
    )
    expect(mocks.store.beginAdmission.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.api.admitFleetTask.mock.invocationCallOrder[0]!
    )
    expect(mocks.api.admitFleetTask).toHaveBeenCalledExactlyOnceWith({
      taskId: 'btk_test1234',
      expectedRevision: 12,
      graph: preview.graph,
      digest: preview.digest,
      contextDigest: preview.admission.context_digest,
      adoptStage: 'build'
    })
    expect(mocks.api.admitFleetTask.mock.calls[0]![0].graph).toBe(preview.graph)
  })

  it('blocks blind retry after an uncertain admission without recapturing or pausing early', async () => {
    const { result, review } = await preparedHook()
    mocks.api.admitFleetTask.mockRejectedValueOnce(new Error('Fleet contact interrupted.'))
    await expect(result.current.onDispatch(review)).rejects.toThrow('Fleet contact interrupted.')
    await expect(result.current.onDispatch(review)).rejects.toThrow(/reviewed dispatch changed/i)
    expect(mocks.api.admitFleetTask).toHaveBeenCalledOnce()
    expect(mocks.store.beginAdmission).toHaveBeenCalledOnce()
    expect(mocks.store.remember).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(mocks.upload).toHaveBeenCalledOnce()
  })

  it('never admits or pauses when committing pending intent fails', async () => {
    const { result, review } = await preparedHook()
    mocks.store.beginAdmission.mockResolvedValue(false)
    await expect(result.current.onDispatch(review)).rejects.toThrow(/could not be committed/)
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
  })

  it('retains the operation, reviewed graph and complete SSH source before admission', async () => {
    const { result, review } = await preparedHook()
    await result.current.onDispatch(review)
    expect(mocks.store.beginAdmission).toHaveBeenCalledWith(
      'person-a',
      expect.objectContaining({
        intent: {
          operationId: expect.any(String),
          request: mocks.api.admitFleetTask.mock.calls[0]![0],
          source: captured
        }
      })
    )
  })

  it.each(['reported', 'thrown'] as const)(
    'retains admitted work and warns when the source pause failure is %s',
    async (failure) => {
      const { result, review } = await preparedHook()
      if (failure === 'reported') {
        mocks.pause.mockResolvedValue({
          state: 'unverifiable',
          message: 'Source host unreachable.'
        })
      } else {
        mocks.pause.mockRejectedValue(new Error('Source host unreachable.'))
      }
      await act(async () => {
        await result.current.onDispatch(review)
      })
      expect(mocks.store.remember).toHaveBeenCalledWith(
        'person-a',
        expect.objectContaining({ workflowId: admitted.workflow_id, rowKey: session.rowKey }),
        admitted.jobs
      )
      expect(mocks.store.remember.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.pause.mock.invocationCallOrder[0]!
      )
      expect(mocks.pause).toHaveBeenCalledWith(session, captured, admitted)
      expect(mocks.toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('Dispatched'),
        expect.objectContaining({ description: 'Source host unreachable.' })
      )
      expect(mocks.toast.success).not.toHaveBeenCalled()
      await expect(result.current.onDispatch(review)).rejects.toThrow(/reviewed dispatch changed/i)
      expect(mocks.api.admitFleetTask).toHaveBeenCalledOnce()
    }
  )

  it('restores the same operation and machine/file selections after a surface remount', async () => {
    const first = await preparedHook()
    const operationId = mocks.compile.mock.calls[0]![0].operationId
    act(() => {
      first.result.current.onMachineChange('fleet-mac')
      first.result.current.onSourceSelectionChange({
        paths: ['report.md'],
        includeDirtyTracked: false
      })
    })
    first.unmount()
    const second = await preparedHook()
    expect(second.result.current.machineId).toBe('fleet-mac')
    expect(second.result.current.sourceSelection).toEqual({
      paths: ['report.md'],
      includeDirtyTracked: false
    })
    expect(mocks.compile.mock.calls.at(-1)![0].operationId).toBe(operationId)
  })

  it('refuses a prepared graph after the signed-in person changes', async () => {
    const { result, review } = await preparedHook()
    mocks.scope = 'person-b'
    await expect(result.current.onDispatch(review)).rejects.toThrow(/reviewed dispatch changed/i)
    expect(mocks.store.beginAdmission).not.toHaveBeenCalled()
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
  })

  it.each(['capture', 'upload'] as const)(
    'stops preparation if identity changes during %s',
    async (stage) => {
      const capturedLater = Promise.withResolvers<CapturedConversationFleetContext>()
      const uploadedLater = Promise.withResolvers<PreparedConversationFleetInputs>()
      if (stage === 'capture') {
        mocks.capture.mockReturnValue(capturedLater.promise)
      } else {
        mocks.upload.mockReturnValue(uploadedLater.promise)
      }
      const hook = renderHook(() => useFleetDispatch({ kind: 'session', session }))
      await waitFor(() => expect(hook.result.current.machines.phase).toBe('ready'))
      const preparation = hook.result.current.onPrepare(draft, 'fleet-mac')
      await waitFor(() =>
        expect(stage === 'capture' ? mocks.capture : mocks.upload).toHaveBeenCalledOnce()
      )
      mocks.scope = 'person-b'
      await act(async () => {
        const rejected = expect(preparation).rejects.toThrow(/signed-in person changed/i)
        if (stage === 'capture') {
          capturedLater.resolve(captured)
        } else {
          uploadedLater.resolve(inputs)
        }
        await rejected
      })
      if (stage === 'capture') {
        expect(mocks.upload).not.toHaveBeenCalled()
      }
      expect(mocks.api.previewFleetTask).not.toHaveBeenCalled()
      expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
      expect(mocks.pause).not.toHaveBeenCalled()
    }
  )

  it('does not write an old admission or pause its source after an identity change during the request', async () => {
    const { result, review } = await preparedHook()
    const pending =
      Promise.withResolvers<Awaited<ReturnType<ConsoleWorkflowApi['admitFleetTask']>>>()
    mocks.api.admitFleetTask.mockReturnValue(pending.promise)
    const dispatch = result.current.onDispatch(review)
    await waitFor(() => expect(mocks.api.admitFleetTask).toHaveBeenCalledOnce())
    mocks.scope = 'person-b'
    await act(async () => {
      pending.resolve({ ok: true, data: admitted })
      await dispatch
    })
    expect(mocks.store.remember).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(mocks.toast.warning).not.toHaveBeenCalled()
  })

  it('does not associate a different admitted workflow with the source conversation', async () => {
    const { result, review } = await preparedHook()
    mocks.api.admitFleetTask.mockResolvedValue({
      ok: true,
      data: { ...admitted, workflow_id: 'wf_other' }
    })
    await expect(result.current.onDispatch(review)).rejects.toThrow(/different workflow/i)
    expect(mocks.store.remember).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('invalidates the reviewed graph when the source file selection changes', async () => {
    const { result, review } = await preparedHook()
    act(() =>
      result.current.onSourceSelectionChange({ paths: ['report.md'], includeDirtyTracked: false })
    )
    await expect(result.current.onDispatch(review)).rejects.toThrow(/reviewed dispatch changed/i)
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
  })

  it('does not preview or admit a capture whose repository changed during upload', async () => {
    inputs.remoteUrl = 'https://github.com/Other/project.git'
    const hook = renderHook(() => useFleetDispatch({ kind: 'session', session }))
    await waitFor(() => expect(hook.result.current.machines.phase).toBe('ready'))
    await act(async () => {
      await expect(hook.result.current.onPrepare(draft, 'fleet-mac')).rejects.toThrow(
        /repository changed during capture/i
      )
    })
    expect(mocks.api.previewFleetTask).not.toHaveBeenCalled()
    expect(mocks.api.admitFleetTask).not.toHaveBeenCalled()
    expect(mocks.pause).not.toHaveBeenCalled()
  })
})
