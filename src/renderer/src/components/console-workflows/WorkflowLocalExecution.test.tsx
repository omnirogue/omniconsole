// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLocalExecution } from './WorkflowLocalExecution'
import { workflowDigest, workflowExecutionFixture } from './console-workflow-test-fixtures'

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
const api = { list: vi.fn(), start: vi.fn(), focus: vi.fn(), cancel: vi.fn(), readWorker: vi.fn() }
const onRefresh = vi.fn()
const execution = workflowExecutionFixture()
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleLocalExecution: api }
  })
  api.list.mockResolvedValue({ ok: true, data: [] })
  api.start.mockResolvedValue({ ok: true, data: execution })
})
afterEach(cleanup)

function controls(canStart = true) {
  return (
    <WorkflowLocalExecution
      jobId="job_build"
      workflowId="wf_test"
      digest={workflowDigest}
      canStart={canStart}
      onRefresh={onRefresh}
    />
  )
}
describe('explicit local job operations', () => {
  it('only reads on mount, including StrictMode effect replay', async () => {
    render(<StrictMode>{controls()}</StrictMode>)
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeEnabled())
    expect(api.start).not.toHaveBeenCalled()
    expect(api.cancel).not.toHaveBeenCalled()
    expect(api.focus).not.toHaveBeenCalled()
  })

  it('starts only the clicked job with its digest and selected folder workspace', async () => {
    render(controls())
    const picker = screen.getByRole('combobox', { name: 'Workspace' })
    await waitFor(() => expect(picker).toBeEnabled())
    fireEvent.keyDown(picker, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'Scratch' }))
    expect(api.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start this job locally' }))
    await waitFor(() =>
      expect(api.start).toHaveBeenCalledExactlyOnceWith({
        jobId: 'job_build',
        workflowId: 'wf_test',
        approvedDigest: workflowDigest,
        worktree: 'id:folder:folder-1'
      })
    )
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('cannot start when the server has not marked the job ready for local execution', async () => {
    render(controls(false))
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Start this job locally' })).toBeDisabled()
    expect(api.start).not.toHaveBeenCalled()
  })

  it('keeps loss of contact unverifiable and reads the existing worker transcript explicitly', async () => {
    api.list.mockResolvedValue({ ok: true, data: [{ ...execution, state: 'unverifiable' }] })
    api.readWorker.mockResolvedValue({
      ok: true,
      data: {
        source: 'terminal',
        warnings: ['Remote host unreachable'],
        status: { liveness: 'unverifiable' }
      }
    })
    api.cancel.mockResolvedValue({ ok: true, data: { ...execution, state: 'unverifiable' } })
    render(controls())
    await screen.findByText('unverifiable')
    expect(screen.queryByRole('button', { name: 'Start this job locally' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Read transcript' }))
    expect(await screen.findByLabelText('Transcript')).toHaveTextContent('Remote host unreachable')
    fireEvent.click(screen.getByRole('button', { name: 'Stop local job' }))
    await waitFor(() => expect(api.cancel).toHaveBeenCalledExactlyOnceWith({ jobId: 'job_build' }))
    expect(screen.queryByText('exited')).not.toBeInTheDocument()
  })
})
