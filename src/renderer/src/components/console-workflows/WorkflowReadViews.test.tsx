// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowGraph } from './WorkflowGraph'
import { WorkflowJobsList } from './WorkflowJobsList'
import { WorkflowTimeline } from './WorkflowTimeline'
import { WorkflowInspector } from './WorkflowInspector'
import { workflowExecutionFixture, workflowJobFixture } from './console-workflow-test-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string) => value,
  i18n: { language: 'en' }
}))
vi.mock('./WorkflowLocalExecution', () => ({
  WorkflowLocalExecution: () => <div>Local operations</div>
}))
const api = {
  listJobs: vi.fn(),
  getJob: vi.fn(),
  listJobEvents: vi.fn()
}
const localApi = { list: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  localApi.list.mockResolvedValue({ ok: true, data: [] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleWorkflows: api, consoleLocalExecution: localApi }
  })
})
afterEach(cleanup)

describe('server workflow read views', () => {
  it('renders after edges, conditions and machine badges from the supplied graph', () => {
    const select = vi.fn()
    render(
      <WorkflowGraph
        nodes={[
          {
            key: 'review',
            title: 'Review',
            after: ['build'],
            actorType: 'human',
            machine: 'office-host',
            status: 'queued',
            conditions: 'approved inputs required'
          },
          {
            key: 'build',
            title: 'Build',
            after: [],
            actorType: 'ai',
            placement: 'local',
            status: 'running'
          }
        ]}
        selectedKey="build"
        onSelect={select}
      />
    )
    expect(screen.getByText('After: build')).toBeInTheDocument()
    expect(screen.getByText('office-host')).toBeInTheDocument()
    expect(screen.getByText('Conditions: approved inputs required')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Review'))
    expect(select).toHaveBeenCalledWith('review')
  })

  it('shows ordinary stored jobs without inventing a workflow link or eligibility', async () => {
    api.listJobs.mockResolvedValue({
      ok: true,
      data: {
        jobs: [
          {
            id: 'job_plain',
            task_id: 'btk_test1234',
            title: 'Ordinary job',
            status: 'queued',
            policy: {}
          }
        ]
      }
    })
    render(<WorkflowJobsList taskId="btk_test1234" onOpen={vi.fn()} />)
    await screen.findByText('Ordinary job')
    expect(screen.getByRole('button', { name: 'Open workflow' })).toBeDisabled()
    expect(api.listJobs).toHaveBeenCalledExactlyOnceWith({ taskId: 'btk_test1234' })
  })

  it('scopes default jobs to explicit local bindings and their workflows', async () => {
    const localJob = workflowJobFixture()
    const fleetJob = workflowJobFixture({
      id: 'job_fleet',
      title: 'Fleet review',
      machine: 'office-host'
    })
    const unrelated = workflowJobFixture({
      id: 'job_other',
      title: 'Unrelated workflow',
      policy: { workflow: { ...localJob.policy.workflow, dispatch_id: 'wf_other' } }
    })
    api.listJobs.mockResolvedValue({ ok: true, data: { jobs: [localJob, fleetJob, unrelated] } })
    localApi.list.mockResolvedValue({
      ok: true,
      data: [workflowExecutionFixture({ state: 'unverifiable' })]
    })
    render(<WorkflowJobsList taskId={null} onOpen={vi.fn()} />)
    await screen.findByText('Build search')
    expect(screen.getByText('Fleet review')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated workflow')).not.toBeInTheDocument()
    expect(screen.getAllByText('Local · unverifiable')).toHaveLength(1)
    expect(screen.getByText('term_test')).toBeInTheDocument()
    expect(screen.getByText(/office-host/)).toBeInTheDocument()
  })

  it('does not show global server jobs when none were explicitly activated locally', async () => {
    api.listJobs.mockResolvedValue({ ok: true, data: { jobs: [workflowJobFixture()] } })
    render(<WorkflowJobsList taskId={null} onOpen={vi.fn()} />)
    await screen.findByText('No jobs activated on this computer.')
    expect(screen.queryByText('Build search')).not.toBeInTheDocument()
  })

  it('keeps known local bindings visible if the server job read fails', async () => {
    api.listJobs.mockResolvedValue({
      ok: false,
      error: { code: 'unavailable', message: 'Server unreachable' }
    })
    localApi.list.mockResolvedValue({ ok: true, data: [workflowExecutionFixture()] })
    render(<WorkflowJobsList taskId={null} onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unreachable')
    expect(screen.getByText('job_build')).toBeInTheDocument()
    expect(screen.getByText('term_test')).toBeInTheDocument()
  })

  it('does not expose global jobs as a fallback when the local list fails', async () => {
    api.listJobs.mockResolvedValue({ ok: true, data: { jobs: [workflowJobFixture()] } })
    localApi.list.mockResolvedValue({
      ok: false,
      error: { code: 'unavailable', message: 'Local list unavailable' }
    })
    render(<WorkflowJobsList taskId={null} onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Local list unavailable')
    expect(screen.queryByText('Build search')).not.toBeInTheDocument()
  })

  it('renders only server job events and refuses events for another job', async () => {
    api.listJobEvents.mockResolvedValue({
      ok: true,
      data: {
        job_id: 'job_build',
        events: [
          {
            id: 17,
            job_id: 'job_build',
            kind: 'started',
            created_at: '2026-09-08T12:00:00Z',
            detail: { input_digest: 'observed-digest' }
          }
        ]
      }
    })
    render(<WorkflowTimeline jobId="job_build" />)
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('observed-digest'))
    expect(screen.getByRole('log')).toHaveTextContent('2026-09-08T12:00:00Z')
    api.listJobEvents.mockResolvedValue({ ok: true, data: { job_id: 'job_other', events: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh events' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server returned events for a different job.'
    )
  })

  it('merges stored branch and output with the graph projection and renders provider-neutral review links', async () => {
    api.getJob.mockResolvedValue({
      ok: true,
      data: {
        id: 'job_build',
        task_id: 'btk_test1234',
        title: 'Build search',
        status: 'pr_open',
        branch: 'feature/search',
        brief: 'Read and build',
        output_tail: 'Checks passed: 12',
        pr_url: 'https://gitlab.example/team/project/-/merge_requests/7',
        policy: {}
      }
    })
    render(
      <WorkflowInspector
        job={workflowJobFixture({ blockers: ['review pending'] })}
        workflowId="wf_test"
        onRefresh={vi.fn()}
      />
    )
    await screen.findByText('feature/search')
    expect(screen.getByText('Checks passed: 12')).toBeInTheDocument()
    expect(screen.getByText(/"review pending"/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open review' })).toHaveAttribute(
      'href',
      'https://gitlab.example/team/project/-/merge_requests/7'
    )
    expect(
      screen.getByText('The exact execution prompt is unavailable in this server view.')
    ).toBeInTheDocument()
  })

  it('replays local events from zero after remount and advances only with the server cursor', async () => {
    const event = {
      id: 17,
      job_id: 'job_build',
      kind: 'started',
      created_at: '2026-09-08T12:00:00Z',
      detail: { receipt: 'first' }
    }
    api.listJobEvents.mockResolvedValueOnce({
      ok: true,
      data: { job_id: 'job_build', events: [event], next_after: 17 }
    })
    const view = render(<WorkflowTimeline jobId="job_build" replay />)
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('first'))
    api.listJobEvents.mockResolvedValueOnce({
      ok: true,
      data: {
        job_id: 'job_build',
        events: [{ ...event, id: 18, detail: { receipt: 'second' } }],
        next_after: 18
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh events' }))
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('second'))
    expect(screen.getByRole('log')).toHaveTextContent('first')
    expect(api.listJobEvents).toHaveBeenLastCalledWith({
      jobId: 'job_build',
      limit: 200,
      after: 17
    })
    view.unmount()
    api.listJobEvents.mockResolvedValueOnce({
      ok: true,
      data: { job_id: 'job_build', events: [event], next_after: 17 }
    })
    render(<WorkflowTimeline jobId="job_build" replay />)
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('first'))
    expect(api.listJobEvents).toHaveBeenLastCalledWith({ jobId: 'job_build', limit: 200, after: 0 })
  })
})
