// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleAutoAdvancePreference } from '../../../../shared/console-auto-advance'
import { WorkflowAutoAdvance } from './WorkflowAutoAdvance'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      folderWorkspaces: [
        { id: 'folder-1', name: 'Scratch', folderPath: '/scratch', projectGroupId: 'group-1' }
      ]
    })
}))
vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [{ id: 'repo::/workspace', path: '/workspace', branch: 'feature' }]
}))

const api = {
  list: vi.fn(),
  start: vi.fn(),
  focus: vi.fn(),
  cancel: vi.fn(),
  readWorker: vi.fn(),
  autoAdvanceGet: vi.fn(),
  autoAdvanceSet: vi.fn()
}
const workflowId = 'wf_test'
const preference = (
  overrides: Partial<ConsoleAutoAdvancePreference> = {}
): ConsoleAutoAdvancePreference => ({
  workflowId,
  enabled: false,
  worktree: '',
  status: { state: 'off', reason: null, jobId: null, detail: null, updatedAt: 1 },
  ...overrides
})

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleLocalExecution: api }
  })
  api.autoAdvanceGet.mockResolvedValue({ ok: true, data: preference() })
})
afterEach(cleanup)

describe('per-workflow auto-advance toggle', () => {
  it('is off by default and only reads on mount, including StrictMode replay', async () => {
    render(
      <StrictMode>
        <WorkflowAutoAdvance workflowId={workflowId} />
      </StrictMode>
    )
    await waitFor(() =>
      expect(
        screen.getByText('Auto-advance is off — each local job is started by hand.')
      ).toBeInTheDocument()
    )
    expect(api.autoAdvanceSet).not.toHaveBeenCalled()
    expect(api.start).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Turn auto-advance on' })).toBeDisabled()
  })

  it('turns on for the chosen workspace and shows the waiting line', async () => {
    api.autoAdvanceSet.mockResolvedValue({
      ok: true,
      data: preference({
        enabled: true,
        worktree: 'id:repo::/workspace',
        status: { state: 'waiting', reason: null, jobId: null, detail: null, updatedAt: 2 }
      })
    })
    render(<WorkflowAutoAdvance workflowId={workflowId} />)
    const picker = await screen.findByRole('combobox', { name: 'Workspace' })
    fireEvent.keyDown(picker, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'feature' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn auto-advance on' }))
    await waitFor(() =>
      expect(api.autoAdvanceSet).toHaveBeenCalledExactlyOnceWith({
        workflowId,
        enabled: true,
        worktree: 'id:repo::/workspace'
      })
    )
    expect(
      await screen.findByText('Auto-advance on — waiting for the next local job.')
    ).toBeInTheDocument()
  })

  it('turns off without naming a workspace again', async () => {
    api.autoAdvanceGet.mockResolvedValue({
      ok: true,
      data: preference({
        enabled: true,
        worktree: 'id:repo::/workspace',
        status: { state: 'waiting', reason: null, jobId: null, detail: null, updatedAt: 2 }
      })
    })
    api.autoAdvanceSet.mockResolvedValue({ ok: true, data: preference() })
    render(<WorkflowAutoAdvance workflowId={workflowId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn auto-advance off' }))
    await waitFor(() =>
      expect(api.autoAdvanceSet).toHaveBeenCalledExactlyOnceWith({ workflowId, enabled: false })
    )
  })

  it.each([
    ['human_decision', 'Stopped: human decision.'],
    ['fleet_placement', 'Stopped: fleet placement.'],
    ['folder_workspace', 'Stopped: folder workspace. Choose a Git workspace for this workflow.']
  ] as const)('surfaces the %s stop reason', async (reason, line) => {
    api.autoAdvanceGet.mockResolvedValue({
      ok: true,
      data: preference({
        enabled: true,
        worktree: 'id:repo::/workspace',
        status: { state: 'stopped', reason, jobId: null, detail: null, updatedAt: 3 }
      })
    })
    render(<WorkflowAutoAdvance workflowId={workflowId} />)
    expect(await screen.findByText(line)).toBeInTheDocument()
  })

  it('reports a refused read without offering the toggle', async () => {
    api.autoAdvanceGet.mockResolvedValue({
      ok: false,
      error: { code: 'auto_advance_refused', message: 'No admitted workflow.' }
    })
    render(<WorkflowAutoAdvance workflowId={workflowId} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('No admitted workflow.')
    expect(screen.getByRole('button', { name: 'Turn auto-advance on' })).toBeDisabled()
  })
})
