// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleJobRecord } from '../../../../shared/console-workflow-types'
import type { ConsoleJobResults } from '../../../../shared/console-job-results'
import { WorkflowJobResults } from './WorkflowJobResults'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  focus: vi.fn(),
  open: vi.fn(),
  download: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'person-scope' }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ openTaskPage: mocks.open }) } }))
vi.mock('@/components/task-page/backoffice/backoffice-work-selection', () => ({
  useBackofficeWorkFocus: { getState: () => ({ focus: mocks.focus }) }
}))
vi.mock('@/components/handoffs/handoff-client', () => ({
  downloadExactHandoffFile: mocks.download
}))
vi.mock('@/components/handoffs/HandoffDetailView', () => ({
  HandoffDetailView: ({ threadId }: { threadId: string }) => (
    <div data-testid="handoff-thread">{threadId}</div>
  )
}))

const job: ConsoleJobRecord = {
  id: 'job_result001',
  task_id: 'btk_1234',
  title: 'Produce a report',
  status: 'done',
  attempt: 2,
  policy: {},
  execution_artifacts: [
    {
      job_id: 'job_result001',
      attempt: 2,
      file_id: 'tfl_report',
      principal: 'emp_director',
      sha256: 'a'.repeat(64),
      rel: 'uploads/report.json',
      size_bytes: 400
    }
  ]
}
const result: ConsoleJobResults = {
  job_id: job.id,
  attempt: 2,
  receipt: job.execution_artifacts![0],
  response: 'Completed the requested report.',
  changed_files: ['reports/final.txt', 'removed.txt'],
  files: [
    {
      path: 'reports/final.txt',
      mode: 420,
      sha256: 'b'.repeat(64),
      size_bytes: 5,
      content_b64: 'aGVsbG8='
    }
  ]
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockResolvedValue({ ok: true, data: result })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleWorkflows: { readJobResults: mocks.read } }
  })
})
afterEach(cleanup)

describe('workflow result access', () => {
  it('opens the task without requiring a copied identifier', () => {
    render(<WorkflowJobResults job={job} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    expect(mocks.focus).toHaveBeenCalledWith({ scope: 'person-scope', taskId: job.task_id })
    expect(mocks.open).toHaveBeenCalledWith({ taskSource: 'backoffice' })
  })

  it('loads only on request and downloads the verified bytes of the chosen output file', async () => {
    render(<WorkflowJobResults job={job} />)
    expect(mocks.read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open result files' }))
    expect(await screen.findByText(result.response)).toBeInTheDocument()
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ jobId: job.id, attempt: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Download reports/final.txt' }))
    expect(mocks.download).toHaveBeenCalledWith({
      name: 'final.txt',
      sha256: 'b'.repeat(64),
      size: 5,
      contentBase64: 'aGVsbG8='
    })
    expect(screen.getByText('Deleted files: removed.txt')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it("does not offer another attempt's files and rejects a mismatched returned report", async () => {
    const view = render(<WorkflowJobResults job={{ ...job, attempt: 3 }} />)
    expect(screen.queryByRole('button', { name: 'Open result files' })).not.toBeInTheDocument()
    view.rerender(<WorkflowJobResults job={job} />)
    mocks.read.mockResolvedValue({ ok: true, data: { ...result, attempt: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'Open result files' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('different job attempt')
    expect(screen.queryByText(result.response)).not.toBeInTheDocument()
  })

  it('keeps server permission refusals actionable', async () => {
    mocks.read.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'This result is not shared with you.' }
    })
    render(<WorkflowJobResults job={job} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open result files' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This result is not shared with you.'
    )
  })

  it("opens the existing thread only for this job's acknowledged recipient and author", () => {
    const delivered = {
      ...job,
      policy: {
        workflow: {
          person_handoff: {
            recipient_employee_id: 'emp_recipient',
            participants: { director: { employee_id: 'emp_director' } }
          }
        },
        person_handoff_delivery: {
          status: 'delivered',
          job_id: job.id,
          request_digest: 'c'.repeat(64),
          recipient_employee_id: 'emp_recipient',
          author_employee_id: 'emp_director',
          thread_id: 'hth_delivered',
          delivery_id: 'delivery_1'
        }
      }
    } as ConsoleJobRecord
    const view = render(<WorkflowJobResults job={delivered} />)
    expect(screen.queryByTestId('handoff-thread')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open delivered handoff' }))
    expect(screen.getByTestId('handoff-thread')).toHaveTextContent('hth_delivered')
    view.rerender(
      <WorkflowJobResults
        job={{
          ...delivered,
          policy: {
            ...delivered.policy,
            person_handoff_delivery: {
              ...delivered.policy.person_handoff_delivery!,
              job_id: 'job_other001'
            }
          }
        }}
      />
    )
    expect(screen.queryByRole('button', { name: 'Open delivered handoff' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('handoff-thread')).not.toBeInTheDocument()
  })

  it('does not publish an in-flight report after the job attempt changes', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<WorkflowJobResults job={job} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open result files' }))
    view.rerender(<WorkflowJobResults job={{ ...job, attempt: 3 }} />)
    finish({ ok: true, data: result })
    await waitFor(() => expect(screen.queryByText(result.response)).not.toBeInTheDocument())
  })
})
