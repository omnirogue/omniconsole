// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { workflowExecutionFixture } from '@/components/console-workflows/console-workflow-test-fixtures'
import type * as WorkflowFieldsModule from '@/components/console-workflows/WorkflowFields'
import { TaskContinuationBody } from './TaskContinuationModal'
import type { TaskContinuationModalData } from './task-continuation'

const capabilities = vi.hoisted(() => [
  {
    id: 'codex',
    status: 'usable',
    models: ['gpt-6-astra', 'gpt-5.6-sol'].map((id, index) => ({
      id,
      label: id,
      isDefault: index === 0,
      options: [
        {
          id: 'effort',
          kind: {
            type: 'select',
            choices: ['high', 'xhigh'].map((value) => ({ value, label: value }))
          }
        }
      ]
    }))
  }
])
const mocks = vi.hoisted(() => ({
  continueTask: vi.fn(),
  refresh: vi.fn(),
  close: vi.fn(),
  target: vi.fn(),
  activateWorkspace: vi.fn(),
  focusTerminal: vi.fn(),
  focusExecution: vi.fn(),
  setTabViewMode: vi.fn(),
  chatEligibility: vi.fn(),
  capabilities: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateWorkspace
}))
vi.mock('@/components/terminal-pane/terminal-handle-links', () => ({
  focusRendererTerminalHandle: mocks.focusTerminal,
  findTerminalHandleTarget: () => ({ worktreeId: 'wt_test', tabId: 'terminal_test', leafId: null })
}))
vi.mock('@/components/native-chat/native-chat-tab-toggle', () => ({
  findUnifiedTabIdForTerminalTab: () => 'conversation_test',
  resolveNativeChatTabToggle: mocks.chatEligibility
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        folderWorkspaces: [
          { id: 'folder-1', name: 'Scratch', folderPath: '/scratch', projectGroupId: 'group-1' }
        ]
      }),
    { getState: () => ({ setTabViewMode: mocks.setTabViewMode }) }
  )
}))
vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [
    { id: 'worktree-local', path: '/workspace', branch: 'feature' },
    { id: 'worktree-remote', path: '/remote/workspace', branch: 'remote' },
    { id: 'worktree-unknown', path: '/unknown/workspace', branch: 'unknown' }
  ]
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: mocks.target
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: mocks.capabilities
}))
vi.mock('@/components/console-workflows/WorkflowFields', async (importOriginal) => {
  const original = await importOriginal<typeof WorkflowFieldsModule>()
  return {
    ...original,
    WorkflowSelect: ({
      label,
      value,
      onChange,
      options,
      disabled
    }: {
      label: string
      value: string
      onChange: (value: string) => void
      options: { value: string; label: string }[]
      disabled?: boolean
    }) => (
      <label>
        {label}
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          <option value="">Choose a location</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )
  }
})
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: ({
    model,
    effort,
    onChange
  }: {
    model?: string
    effort?: string
    onChange: (choice: { model?: string; effort?: string }) => void
  }) => (
    <>
      <label>
        Model
        <select
          value={model ?? ''}
          onChange={(event) => onChange({ model: event.target.value, effort })}
        >
          <option value="">Default model</option>
          {capabilities[0].models.map((entry) => (
            <option key={entry.id}>{entry.id}</option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select
          value={effort ?? ''}
          onChange={(event) => onChange({ model, effort: event.target.value })}
        >
          <option value="">Default effort</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
      </label>
    </>
  )
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    ),
  i18n: { language: 'en' }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))

const data: TaskContinuationModalData = {
  taskId: 'btk_test1234',
  threadId: 'hth_source',
  title: 'Finish the report',
  agent: 'codex',
  model: 'gpt-6-astra',
  effort: 'xhigh',
  instruction: 'Review: Finish the handed-off report.',
  operationId: 'ns_continuation_test'
}
const instruction = 'Finish the report.\nCheck the figures and attach the result.'
const taskSetupRequired = {
  ok: false,
  error: {
    code: 'task_setup_required',
    message: 'Choose the outcome this task supports.',
    taskSetup: {
      gaps: ['task_goal_missing'],
      company_id: 'company_test',
      goals: [
        { id: 'cgl_active', title: 'Publish the report', status: 'active' },
        { id: 'cgl_completed', title: 'Completed outcome', status: 'completed' }
      ]
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.continueTask.mockResolvedValue({ ok: true, data: workflowExecutionFixture() })
  mocks.focusTerminal.mockReturnValue(true)
  mocks.focusExecution.mockResolvedValue({ ok: true, data: null })
  mocks.chatEligibility.mockReturnValue({ eligible: true })
  mocks.refresh.mockResolvedValue(capabilities)
  mocks.capabilities.mockReturnValue({
    usable: capabilities,
    loading: false,
    refresh: mocks.refresh
  })
  mocks.target.mockImplementation((worktreeId: string | null) => {
    if (!worktreeId || worktreeId === 'worktree-unknown') {
      return null
    }
    return worktreeId === 'worktree-remote'
      ? { kind: 'ssh', connectionId: 'remote' }
      : { kind: 'local' }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      consoleLocalExecution: { continueTask: mocks.continueTask, focus: mocks.focusExecution }
    }
  })
})
afterEach(cleanup)

function chooseLocation(worktree = 'id:folder:folder-1'): void {
  fireEvent.change(screen.getByRole('combobox', { name: 'Work location' }), {
    target: { value: worktree }
  })
}

describe('TaskContinuationBody', () => {
  it.each(['id:worktree-local', 'id:folder:folder-1'])(
    'requires an existing location and submits its exact selector %s with edited choices',
    async (worktree) => {
      render(<TaskContinuationBody data={data} onClose={mocks.close} />)
      const start = screen.getByRole('button', { name: 'Start agent' })
      expect(start).toBeDisabled()
      expect(screen.getByRole('combobox', { name: 'Work location' })).toHaveValue('')
      fireEvent.click(start)
      expect(mocks.continueTask).not.toHaveBeenCalled()
      chooseLocation(worktree)
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-sol' } })
      fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } })
      fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: instruction } })
      expect(start).toBeEnabled()
      fireEvent.click(start)
      fireEvent.click(start)
      await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce())
      expect(mocks.continueTask).toHaveBeenCalledExactlyOnceWith({
        taskId: data.taskId,
        threadId: data.threadId,
        operationId: data.operationId,
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        instruction,
        worktree
      })
      expect(mocks.capabilities).toHaveBeenCalledWith(
        worktree.slice(3),
        data.taskId,
        'task-continuation'
      )
      expect(mocks.refresh).toHaveBeenCalledOnce()
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Codex started on this task.')
      expect(mocks.activateWorkspace).toHaveBeenCalledExactlyOnceWith('folder:folder-1', {
        providesInitialSurface: true
      })
      expect(mocks.focusTerminal).toHaveBeenCalledExactlyOnceWith('term_test', null)
      expect(mocks.focusExecution).not.toHaveBeenCalled()
      expect(mocks.setTabViewMode).toHaveBeenCalledExactlyOnceWith('conversation_test', 'chat')
    }
  )

  it.each([
    {
      state: 'refused',
      response: {
        ok: false,
        error: { code: 'stale_revision', message: 'The task revision changed.' }
      },
      message: 'The task revision changed.'
    },
    ...(['starting', 'unverifiable'] as const).map((state) => ({
      state,
      response: { ok: true, data: workflowExecutionFixture({ state }) },
      message: `The agent is not confirmed running (${state}). Your instructions are kept; retry to check this same request.`
    }))
  ])(
    'keeps the draft and operation ID after $state until a retry confirms running',
    async ({ response, message }) => {
      mocks.continueTask.mockResolvedValueOnce(response)
      render(<TaskContinuationBody data={data} onClose={mocks.close} />)
      chooseLocation()
      fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: instruction } })
      fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(mocks.close).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      expect(mocks.activateWorkspace).not.toHaveBeenCalled()
      expect(mocks.focusTerminal).not.toHaveBeenCalled()
      expect(mocks.focusExecution).not.toHaveBeenCalled()
      expect(screen.getByLabelText('Instructions')).toHaveValue(instruction)
      expect(screen.getByLabelText('Model')).toHaveValue(data.model)
      expect(screen.getByLabelText('Effort')).toHaveValue(data.effort)
      expect(screen.getByRole('combobox', { name: 'Work location' })).toHaveValue(
        'id:folder:folder-1'
      )
      expect(screen.getByRole('button', { name: 'Start agent' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
      await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce())
      const request = {
        taskId: data.taskId,
        threadId: data.threadId,
        operationId: data.operationId,
        agent: data.agent,
        model: data.model,
        effort: data.effort,
        instruction,
        worktree: 'id:folder:folder-1'
      }
      expect(mocks.continueTask.mock.calls).toEqual([[request], [request]])
      expect(toast.success).toHaveBeenCalledOnce()
    }
  )

  it.each(['focused', 'refused', 'rejects'])(
    'keeps launch success when fallback focus %s',
    async (outcome) => {
      mocks.focusTerminal.mockReturnValue(false)
      if (outcome === 'rejects') {
        mocks.focusExecution.mockRejectedValue(new Error('Terminal unavailable.'))
      } else if (outcome === 'refused') {
        mocks.focusExecution.mockResolvedValue({
          ok: false,
          error: { code: 'focus_failed', message: 'Terminal unavailable.' }
        })
      }
      render(<TaskContinuationBody data={data} onClose={mocks.close} />)
      chooseLocation()
      fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
      await waitFor(() =>
        expect(mocks.focusExecution).toHaveBeenCalledExactlyOnceWith({ jobId: 'job_build' })
      )
      expect(mocks.close).toHaveBeenCalledOnce()
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('Codex started on this task.')
      expect(mocks.continueTask).toHaveBeenCalledOnce()
      if (outcome === 'focused') {
        expect(toast.warning).not.toHaveBeenCalled()
      } else {
        await waitFor(() =>
          expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
            'The agent started, but its conversation could not be opened; open it from your work list.'
          )
        )
      }
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    }
  )

  it('requires an explicit active outcome and retries the same request with the selected goal', async () => {
    mocks.continueTask.mockResolvedValueOnce(taskSetupRequired)
    render(<TaskContinuationBody data={data} onClose={mocks.close} />)
    chooseLocation()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-sol' } })
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: instruction } })
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    const outcome = await screen.findByRole('combobox', {
      name: 'What outcome does this work support?'
    })
    expect(outcome).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Publish the report' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Completed outcome' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled()
    expect(screen.getByLabelText('Instructions')).toHaveValue(instruction)
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.6-sol')
    expect(screen.getByLabelText('Effort')).toHaveValue('high')
    expect(screen.getByRole('combobox', { name: 'Work location' })).toHaveValue(
      'id:folder:folder-1'
    )
    expect(mocks.close).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    expect(mocks.continueTask).toHaveBeenCalledOnce()
    fireEvent.change(outcome, { target: { value: 'cgl_active' } })
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce())
    const request = {
      taskId: data.taskId,
      threadId: data.threadId,
      operationId: data.operationId,
      agent: data.agent,
      model: 'gpt-5.6-sol',
      effort: 'high',
      instruction,
      worktree: 'id:folder:folder-1'
    }
    expect(mocks.continueTask.mock.calls).toEqual([
      [request],
      [{ ...request, goalId: 'cgl_active' }]
    ])
  })

  it('keeps starting disabled when task setup offers no active outcome', async () => {
    mocks.continueTask.mockResolvedValueOnce({
      ...taskSetupRequired,
      error: {
        ...taskSetupRequired.error,
        taskSetup: {
          ...taskSetupRequired.error.taskSetup,
          goals: taskSetupRequired.error.taskSetup.goals.filter((goal) => goal.status !== 'active')
        }
      }
    })
    render(<TaskContinuationBody data={data} onClose={mocks.close} />)
    chooseLocation()
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    const outcome = await screen.findByRole('combobox', {
      name: 'What outcome does this work support?'
    })
    expect(outcome).toHaveValue('')
    expect(screen.queryByRole('option', { name: 'Completed outcome' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    expect(mocks.continueTask).toHaveBeenCalledOnce()
    expect(mocks.close).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Instructions')).toHaveValue(data.instruction)
  })

  it.each(['id:worktree-remote', 'id:worktree-unknown'])(
    'refuses an unavailable execution host %s before admission',
    (worktree) => {
      render(<TaskContinuationBody data={data} onClose={mocks.close} />)
      chooseLocation(worktree)
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This work location is remote or its host is unknown.'
      )
      expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
      expect(mocks.continueTask).not.toHaveBeenCalled()
      expect(mocks.refresh).not.toHaveBeenCalled()
      expect(mocks.close).not.toHaveBeenCalled()
    }
  )

  it('shows the server continuation refusal and keeps the draft without starting', () => {
    mocks.capabilities.mockReturnValue({
      usable: [],
      loading: false,
      continuationUnavailableReason: 'Task continuation is not enabled on this server.',
      refresh: mocks.refresh
    })
    render(<TaskContinuationBody data={data} onClose={mocks.close} />)
    chooseLocation()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Task continuation is not enabled on this server.'
    )
    expect(screen.getByLabelText('Instructions')).toHaveValue(data.instruction)
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled()
    expect(mocks.continueTask).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('retains the draft when refreshed capabilities no longer support the chosen model', async () => {
    mocks.refresh.mockResolvedValue([{ ...capabilities[0], models: [] }])
    render(<TaskContinuationBody data={data} onClose={mocks.close} />)
    chooseLocation()
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This agent or model is no longer available'
    )
    expect(screen.getByLabelText('Instructions')).toHaveValue(data.instruction)
    expect(mocks.continueTask).not.toHaveBeenCalled()
    expect(mocks.close).not.toHaveBeenCalled()
  })
})
