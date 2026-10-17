// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleWorkflowJob } from '../../../../shared/console-workflow-types'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { FleetDispatchDetails } from './FleetDispatchDetails'
import { getIntlLocale } from '@/i18n/i18n'

vi.mock('@/components/console-workflows/WorkflowDetail', () => ({
  WorkflowDetail: () => <div data-testid="technical-workflow">Stage logs</div>
}))

const run: ConversationFleetView = {
  workflowId: 'wf_summary',
  taskId: 'task_summary',
  rowKey: 'summary-row',
  sessionKey: null,
  title: 'Continue work',
  createdAt: '2026-10-03T14:00:00.000Z',
  machine: 'mw0001',
  jobs: [
    { id: 'job_failed', status: 'failed', updated_at: '2026-09-01T12:00:00Z' } as ConsoleWorkflowJob
  ],
  admission: 'accepted',
  verified: true,
  error: 'execution_unresolved: owner lease unavailable'
}

afterEach(cleanup)

describe('fleet work summary', () => {
  it('does not offer cached attention actions after losing contact', async () => {
    const user = userEvent.setup()
    render(
      <FleetDispatchDetails
        run={{
          ...run,
          verified: false,
          jobs: [
            {
              ...run.jobs[0],
              status: 'blocked',
              can_decide: true,
              pr_url: 'https://github.com/example/repo/pull/1'
            }
          ]
        }}
        compact
      />
    )
    await user.click(screen.getByRole('button', { name: 'View summary' }))
    expect(screen.queryByRole('button', { name: 'Open Decisions' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open review' })).toBeNull()
    expect(screen.getByText(/Current status is unavailable/)).toBeTruthy()
  })
  it('keeps summary keyboard navigation out of the sidebar and initially focuses its title', async () => {
    const user = userEvent.setup()
    const sidebarKeyDown = vi.fn()
    render(
      <div onKeyDown={sidebarKeyDown}>
        <FleetDispatchDetails run={run} compact />
      </div>
    )
    await user.click(screen.getByRole('button', { name: 'View summary' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: run.title }))
    await user.keyboard('{ArrowDown}{ArrowUp}{Control>}a{/Control}')
    expect(sidebarKeyDown).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows a short dated summary, loading technical details only when requested', async () => {
    const user = userEvent.setup()
    render(<FleetDispatchDetails run={run} compact />)
    await user.click(screen.getByRole('button', { name: 'View summary' }))
    expect(screen.getByText('Some work couldn’t finish. Steps finished: 0 of 1.')).toBeTruthy()
    expect(screen.getByText('mw0001')).toBeTruthy()
    expect(
      screen.getByText(
        `Updated ${new Date(run.jobs[0].updated_at!).toLocaleString(getIntlLocale())}`
      )
    ).toBeTruthy()
    expect(screen.queryByText(run.error!)).toBeNull()
    expect(screen.queryByTestId('technical-workflow')).toBeNull()
    await user.click(screen.getByText('Technical details'))
    await waitFor(() => expect(screen.getByTestId('technical-workflow')).toBeTruthy())
    expect(screen.getByText(run.error!)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'View summary' }))
    expect(screen.queryByTestId('technical-workflow')).toBeNull()
    expect(screen.queryByText(run.error!)).toBeNull()
  })

  it('labels a recovered receipt date as recorded, without implying a recent run', async () => {
    const user = userEvent.setup()
    render(
      <FleetDispatchDetails
        run={{ ...run, jobs: [{ ...run.jobs[0], updated_at: null }] }}
        compact
      />
    )
    await user.click(screen.getByRole('button', { name: 'View summary' }))
    expect(
      screen.getByText(`Recorded ${new Date(run.createdAt).toLocaleString(getIntlLocale())}`)
    ).toBeTruthy()
    expect(screen.queryByText(/^Updated/)).toBeNull()
  })
})
