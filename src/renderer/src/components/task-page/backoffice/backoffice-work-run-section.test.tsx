// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowJobFixture } from '@/components/console-workflows/console-workflow-test-fixtures'
import type { ConsoleJobRecord } from '../../../../../shared/console-workflow-task-types'
import { BackofficeWorkRunSection } from './backoffice-work-run-section'

const mocks = vi.hoisted(() => ({
  onJobs: null as ((jobs: unknown[]) => void) | null,
  invalidate: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  i18n: { language: 'en' }
}))
vi.mock('@/components/console-workflows/WorkflowDetail', () => ({
  WorkflowDetail: ({
    workflowId,
    onJobs
  }: {
    workflowId: string
    onJobs?: (jobs: unknown[]) => void
  }) => {
    mocks.onJobs = onJobs ?? null
    return <div data-testid="workflow-detail">{`Workflow detail ${workflowId}`}</div>
  }
}))
vi.mock('@/components/console-workflows/WorkflowJobsList', () => ({
  WorkflowJobsList: ({ taskId }: { taskId: string }) => <div>{`Jobs list ${taskId}`}</div>
}))
vi.mock('@/components/console-workflows/WorkflowComposer', () => ({
  WorkflowComposer: ({ initialTaskId }: { initialTaskId: string | null }) => (
    <div>{`Composer for ${initialTaskId}`}</div>
  )
}))
vi.mock('./backoffice-work-store', () => ({ invalidateBackofficeWork: mocks.invalidate }))

const listJobs = vi.fn()

function record(id: string, workflowId: string, updatedAt: string, taskId = 'btk_test1234') {
  const job = workflowJobFixture({ id, task_id: taskId, updated_at: updatedAt })
  job.policy.workflow.workflow_id = workflowId
  return job as unknown as ConsoleJobRecord
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.onJobs = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleWorkflows: { listJobs } }
  })
})
afterEach(cleanup)

describe('the Run section of a card', () => {
  it('offers to run the card as a workflow when none runs on it', async () => {
    listJobs.mockResolvedValue({ ok: true, data: { jobs: [] } })
    render(<BackofficeWorkRunSection scope="acct:org:prod" taskId="btk_test1234" />)
    expect(await screen.findByText('No workflow is running on this card.')).toBeInTheDocument()
    expect(listJobs).toHaveBeenCalledExactlyOnceWith({ taskId: 'btk_test1234' })
    expect(screen.queryByTestId('workflow-detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run this as a workflow' }))
    expect(await screen.findByText('Composer for btk_test1234')).toBeInTheDocument()
  })

  it('opens the one workflow on the card and summarises where the run stands', async () => {
    listJobs.mockResolvedValue({
      ok: true,
      data: { jobs: [record('job_1', 'wf_only', '2026-09-11T10:00:00Z')] }
    })
    render(<BackofficeWorkRunSection scope="acct:org:prod" taskId="btk_test1234" />)
    expect(await screen.findByText('Workflow detail wf_only')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Workflow' })).toBeNull()
    const build = workflowJobFixture({ id: 'job_1', title: 'Build', workflow_state: 'done' })
    build.policy.workflow.key = 'build'
    const review = workflowJobFixture({
      id: 'job_2',
      title: 'Review',
      workflow_state: 'blocked',
      blockers: ['require_merged'],
      machine: 'mw0003'
    })
    review.policy.workflow.key = 'review'
    review.policy.workflow.after = ['job_1']
    mocks.onJobs?.([build, review])
    await waitFor(() => expect(screen.getByText('Stage 2 of 2: Review')).toBeInTheDocument())
    expect(screen.getByText('blocked on require_merged')).toBeInTheDocument()
    expect(screen.getByText('on mw0003')).toBeInTheDocument()
    // Why: the stored-jobs list is a second read; it is fetched only when the person asks for it.
    expect(screen.queryByText('Jobs list btk_test1234')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Jobs and local execution' }))
    expect(screen.getByText('Jobs list btk_test1234')).toBeInTheDocument()
  })

  it('offers a picker when the card was admitted twice, freshest workflow first', async () => {
    listJobs.mockResolvedValue({
      ok: true,
      data: {
        jobs: [
          record('job_a', 'wf_older', '2026-09-01T00:00:00Z'),
          record('job_b', 'wf_newer', '2026-09-10T00:00:00Z'),
          record('job_other', 'wf_elsewhere', '2026-09-11T00:00:00Z', 'btk_other999')
        ]
      }
    })
    render(<BackofficeWorkRunSection scope="acct:org:prod" taskId="btk_test1234" />)
    expect(await screen.findByText('Workflow detail wf_newer')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeInTheDocument()
    // Why: another card's jobs in the answer never widen this card's section.
    expect(screen.queryByText('Workflow detail wf_elsewhere')).toBeNull()
  })

  it('says so when the server does not provide the read, instead of an empty section', async () => {
    listJobs.mockResolvedValue({
      ok: false,
      error: { code: 'capability_unavailable', message: 'No jobs route' }
    })
    render(<BackofficeWorkRunSection scope="acct:org:prod" taskId="btk_test1234" />)
    expect(
      await screen.findByText(/This server does not provide the card’s workflows/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run this as a workflow' })).toBeNull()
  })

  it('names a failed read', async () => {
    listJobs.mockResolvedValue({
      ok: false,
      error: { code: 'backoffice_refused', message: 'The machine principal may not read jobs.' }
    })
    render(<BackofficeWorkRunSection scope="acct:org:prod" taskId="btk_test1234" />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The machine principal may not read jobs.'
    )
  })
})
