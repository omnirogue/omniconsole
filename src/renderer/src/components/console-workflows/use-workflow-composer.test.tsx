// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowComposer } from './use-workflow-composer'
import { workflowAdmissionContext } from '@/lib/console-workflow-admission-draft'
import {
  workflowDigest,
  workflowDraftFixture,
  workflowPreviewFixture
} from './console-workflow-test-fixtures'

const api = {
  inventory: vi.fn(),
  templates: vi.fn(),
  presets: vi.fn(),
  previewTask: vi.fn(),
  admitTask: vi.fn(),
  admit: vi.fn()
}
const getTask = vi.fn()
const onAdmitted = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleWorkflows: { ...api, getTask }, consoleLocalExecution: { start: vi.fn() } }
  })
  api.inventory.mockResolvedValue({
    ok: true,
    data: { providers: [], models: [], people: [], repositories: [], models_fallback: false }
  })
  api.templates.mockResolvedValue({ ok: true, data: [] })
  api.presets.mockResolvedValue({ ok: true, data: [] })
  getTask.mockResolvedValue({ ok: true, data: { id: 'btk_test1234', state_revision: 7 } })
  api.previewTask.mockResolvedValue({ ok: true, data: workflowPreviewFixture() })
  api.admitTask.mockResolvedValue({
    ok: true,
    data: { workflow_id: 'wf_test', jobs: [], receipt: {} }
  })
})
afterEach(cleanup)

async function preparedComposer() {
  const hook = renderHook(() => useWorkflowComposer(null, onAdmitted))
  await waitFor(() => expect(hook.result.current.inventory).not.toBeNull())
  act(() => hook.result.current.update(workflowDraftFixture()))
  return hook
}
async function previewComposer(hook: Awaited<ReturnType<typeof preparedComposer>>) {
  act(() => hook.result.current.previewDraft())
  await waitFor(() => expect(hook.result.current.preview).not.toBeNull())
}

describe('task-bound workflow draft approval', () => {
  it('does not synthesize missing authority or accept empty objective policies', async () => {
    const hook = await preparedComposer()
    for (const patch of [
      { authorityEpoch: '' },
      { acceptancePolicy: '{}' },
      { verificationPolicy: '[]' }
    ]) {
      act(() =>
        hook.result.current.update({
          ...workflowDraftFixture(),
          admission: { ...workflowDraftFixture().admission, ...patch }
        })
      )
      act(() => hook.result.current.previewDraft())
      await waitFor(() => expect(hook.result.current.error).not.toBeNull())
      expect(hook.result.current.preview).toBeNull()
    }
    expect(getTask).not.toHaveBeenCalled()
    expect(api.previewTask).not.toHaveBeenCalled()
    expect(api.admitTask).not.toHaveBeenCalled()
  })
  it('starts local, reads catalogs only on mount, and restores no draft or approval on remount', async () => {
    const hook = await preparedComposer()
    expect(hook.result.current.draft.placement).toBe('local')
    expect(api.previewTask).not.toHaveBeenCalled()
    expect(api.admitTask).not.toHaveBeenCalled()
    await previewComposer(hook)
    hook.unmount()
    const reopened = renderHook(() => useWorkflowComposer(null, onAdmitted))
    expect(reopened.result.current.draft.prompt).toBe('')
    expect(reopened.result.current.preview).toBeNull()
    expect(reopened.result.current.consent).toBe(false)
    expect(api.admitTask).not.toHaveBeenCalled()
    expect(window.api.consoleLocalExecution.start).not.toHaveBeenCalled()
  })

  it('relays the exact reviewed graph and digest once, only after explicit consent', async () => {
    const hook = await preparedComposer()
    await previewComposer(hook)
    act(() => hook.result.current.approve())
    await waitFor(() => expect(hook.result.current.pending).toBe(false))
    expect(api.admitTask).not.toHaveBeenCalled()
    act(() => hook.result.current.setConsent(true))
    act(() => {
      hook.result.current.approve()
      hook.result.current.approve()
    })
    await waitFor(() => expect(onAdmitted).toHaveBeenCalledWith('wf_test'))
    expect(api.admitTask).toHaveBeenCalledExactlyOnceWith({
      taskId: 'btk_test1234',
      expectedRevision: 7,
      graph: workflowPreviewFixture().graph,
      digest: workflowDigest,
      placement: 'local',
      ...workflowAdmissionContext(workflowDraftFixture().admission)
    })
    expect(api.admit).not.toHaveBeenCalled()
    expect(window.api.consoleLocalExecution.start).not.toHaveBeenCalled()
  })

  it('keeps edited and removed stages in one sequence before requesting a preview', async () => {
    const hook = await preparedComposer()
    const draft = hook.result.current.draft
    const first = draft.stages[0]
    act(() =>
      hook.result.current.update({
        ...draft,
        stages: [
          first,
          { ...first, key: 'review', after: [] },
          { ...first, key: 'decide', after: [] }
        ]
      })
    )
    expect(hook.result.current.draft.stages.map((stage) => stage.after)).toEqual([
      [],
      ['build'],
      ['review']
    ])
    act(() =>
      hook.result.current.update({
        ...hook.result.current.draft,
        stages: hook.result.current.draft.stages.filter((stage) => stage.key !== 'review')
      })
    )
    await previewComposer(hook)
    expect(api.previewTask.mock.calls[0][0].classification).toMatchObject({
      execution_mode: 'sequential',
      steps: [
        { key: 'build', after: [] },
        { key: 'decide', after: ['build'] }
      ]
    })
    expect(api.admitTask).not.toHaveBeenCalled()
  })

  it('refuses a parallel server preview without changing prompts or approving it', async () => {
    const preview = workflowPreviewFixture()
    preview.graph.mode = 'parallel'
    api.previewTask.mockResolvedValue({ ok: true, data: preview })
    const hook = await preparedComposer()
    const prompt = hook.result.current.draft.prompt
    act(() => hook.result.current.previewDraft())
    await waitFor(() => expect(hook.result.current.error).toContain('sequential workflow stages'))
    expect(hook.result.current.preview).toBeNull()
    expect(hook.result.current.draft.prompt).toBe(prompt)
    expect(api.admitTask).not.toHaveBeenCalled()
  })

  it('invalidates consent after an edited prompt, placement or provider', async () => {
    const hook = await preparedComposer()
    for (const patch of [
      { prompt: 'changed' },
      { placement: 'fleet' as const },
      { stages: [{ ...workflowDraftFixture().stages[0], provider: 'claude' }] },
      { admission: { ...workflowDraftFixture().admission, authorityEpoch: '4' } },
      { admission: { ...workflowDraftFixture().admission, acceptancePolicy: '{"changed":true}' } },
      {
        stages: [
          {
            ...workflowDraftFixture().stages[0],
            acceptanceCommands: [
              { id: 'command-1', program: 'node', arguments: '["--version"]', timeout: '1000' }
            ]
          }
        ]
      }
    ]) {
      await previewComposer(hook)
      act(() => hook.result.current.setConsent(true))
      act(() => hook.result.current.update({ ...hook.result.current.draft, ...patch }))
      expect(hook.result.current.preview).toBeNull()
      expect(hook.result.current.consent).toBe(false)
    }
    expect(api.admitTask).not.toHaveBeenCalled()
  })

  it('ignores a preview that finishes after the draft changes', async () => {
    let resolvePreview!: (value: unknown) => void
    api.previewTask.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve
      })
    )
    const hook = await preparedComposer()
    act(() => hook.result.current.previewDraft())
    await waitFor(() => expect(api.previewTask).toHaveBeenCalledOnce())
    act(() => hook.result.current.update({ ...hook.result.current.draft, prompt: 'new edits' }))
    await act(async () => resolvePreview({ ok: true, data: workflowPreviewFixture() }))
    expect(hook.result.current.preview).toBeNull()
  })

  it('shows capability failures verbatim and never falls through to legacy admission', async () => {
    api.previewTask.mockResolvedValue({
      ok: false,
      error: { code: 'capability_unavailable', message: 'local placement is not supported' }
    })
    const hook = await preparedComposer()
    act(() => hook.result.current.previewDraft())
    await waitFor(() => expect(hook.result.current.error).toBe('local placement is not supported'))
    expect(hook.result.current.preview).toBeNull()
    expect(api.admit).not.toHaveBeenCalled()
  })

  it('refreshes an observed revision after a stale refusal without retrying approval', async () => {
    api.admitTask.mockResolvedValue({
      ok: false,
      error: { code: 'stale_revision', status: 409, message: 'expected 7, observed 8' }
    })
    const hook = await preparedComposer()
    await previewComposer(hook)
    act(() => hook.result.current.setConsent(true))
    act(() => hook.result.current.approve())
    await waitFor(() => expect(hook.result.current.error).toBe('expected 7, observed 8'))
    expect(getTask).toHaveBeenCalledTimes(2)
    expect(api.admitTask).toHaveBeenCalledOnce()
    expect(hook.result.current.preview).toBeNull()
    expect(onAdmitted).not.toHaveBeenCalled()
  })
})
