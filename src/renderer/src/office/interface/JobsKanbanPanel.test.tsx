// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock the jobs API so we can assert the click-to-prioritise / stage-move wiring
// without a live BFF (the real BFF↔agent path is proven by the live curl DoD).
vi.mock('../integration/fleet/jobsApi', () => ({
  prioritizeJob: vi.fn(async () => ({ job_id: 'wan', priority: 1 })),
  patchJob: vi.fn(async () => ({ job_id: 'wan', status: 'done' })),
  refreshJobs: vi.fn(async () => {})
}))

import { JobsKanbanPanel } from './JobsKanbanPanel'
import { useJobsStore } from '../integration/fleet/jobsStore'
import { patchJob, prioritizeJob } from '../integration/fleet/jobsApi'

const JOBS = [
  {
    job_id: 'wan',
    title: 'wan 3.0 modeli ekliyorum',
    detail: 'add wan 3.0 to create-studio',
    status: 'scheduled',
    priority: 9,
    owner: 'uma',
    source: 'dispatch',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_050,
    sessions: [
      {
        session_ref: 'extproc:claude:1',
        agent_name: 'claude',
        agent_status: 'running',
        machine_id: 'mac'
      }
    ]
  },
  {
    job_id: 'hold1',
    title: 'waiting on review',
    status: 'on_hold',
    priority: 100,
    source: 'manual',
    sessions: []
  },
  {
    job_id: 'run1',
    title: 'building the bundle',
    status: 'in_progress',
    priority: 20,
    source: 'manual',
    sessions: []
  },
  {
    job_id: 'done1',
    title: 'shipped the fix',
    status: 'done',
    priority: 100,
    source: 'manual',
    sessions: []
  },
  {
    job_id: 'derived:extproc:codex:2',
    title: 'omni-console · main',
    detail: 'codex exec work',
    status: 'in_progress',
    priority: 100,
    source: 'derived',
    sessions: [
      {
        session_ref: 'extproc:codex:2',
        agent_name: 'codex',
        agent_status: 'running',
        machine_id: 'mac'
      }
    ]
  }
]

describe('JobsKanbanPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useJobsStore.setState({
      jobs: JOBS as never,
      connected: true,
      lastError: null,
      machineId: 'mac',
      lastUpdated: Date.now()
    })
  })

  it('renders all four stage columns', () => {
    render(<JobsKanbanPanel />)
    for (const label of ['Scheduled', 'On Hold', 'In Progress', 'Done']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('renders JOB titles as cards (explicit + derived repo·branch)', () => {
    render(<JobsKanbanPanel />)
    expect(
      screen.getAllByRole('button', { name: /wan 3\.0 modeli ekliyorum/i })[0]
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /waiting on review/i })[0]).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /building the bundle/i })[0]).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /shipped the fix/i })[0]).toBeInTheDocument()
    // derived job shows repo · branch, never a fabricated human name
    expect(screen.getAllByRole('button', { name: /omni-console · main/i })[0]).toBeInTheDocument()
  })

  it('opens a detail panel on card click and shows bound agent + stage', () => {
    render(<JobsKanbanPanel />)
    fireEvent.click(screen.getAllByRole('button', { name: /wan 3\.0 modeli ekliyorum/i })[0])
    // detail panel content
    expect(screen.getByText('add wan 3.0 to create-studio')).toBeInTheDocument()
    expect(screen.getByText(/Bound agents/i)).toBeInTheDocument()
    expect(screen.getByText('claude')).toBeInTheDocument()
  })

  it('wires Prioritise → POST prioritize(top)', async () => {
    render(<JobsKanbanPanel />)
    fireEvent.click(screen.getAllByRole('button', { name: /wan 3\.0 modeli ekliyorum/i })[0])
    fireEvent.click(screen.getAllByRole('button', { name: /Prioritise — bump to top/i })[0])
    await waitFor(() => expect(prioritizeJob).toHaveBeenCalledWith('wan', 'top'))
  })

  it('wires a stage button → PATCH status', async () => {
    render(<JobsKanbanPanel />)
    fireEvent.click(screen.getAllByRole('button', { name: /wan 3\.0 modeli ekliyorum/i })[0])
    // the modal's "Move stage" group; the current stage (Scheduled) is disabled.
    const doneBtn = screen.getByRole('button', { name: 'Done' })
    fireEvent.click(doneBtn)
    await waitFor(() => expect(patchJob).toHaveBeenCalledWith('wan', { status: 'done' }))
  })

  it('a derived job is read-only (no prioritise control)', () => {
    render(<JobsKanbanPanel />)
    fireEvent.click(screen.getAllByRole('button', { name: /omni-console · main/i })[0])
    expect(screen.getByText(/Derived from a running session/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Prioritise — bump to top/i })).toBeNull()
  })
})
