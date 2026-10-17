// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'
import {
  FleetDispatchSummaryProvider,
  useFleetDispatchSummary
} from './FleetDispatchSummaryProvider'

vi.mock('@/components/console-workflows/WorkflowDetail', () => ({
  WorkflowDetail: () => <div data-testid="technical-details" />
}))

const run: ConversationFleetView = {
  workflowId: 'wf_summary',
  taskId: 'btk_12345678',
  rowKey: 'row-summary',
  sessionKey: null,
  title: 'Find the launch problem',
  createdAt: '2026-10-03T12:00:00.000Z',
  machine: 'mw0002',
  jobs: [{ id: 'job_summary', status: 'running', machine: 'mw0002' } as ConsoleWorkflowJob],
  admission: 'accepted',
  verified: true,
  error: null
}
const originalProfile = useAppStore.getState().activeOrcaProfileId
const defaultRuns = [run]

function Launcher() {
  const { openSummary } = useFleetDispatchSummary()
  return <button onClick={(event) => openSummary(run, event.currentTarget)}>Open summary</button>
}

function Fixture({
  visible = true,
  runs = defaultRuns
}: {
  visible?: boolean
  runs?: ConversationFleetView[]
}) {
  return (
    <FleetDispatchSummaryProvider runs={runs}>
      <div role="listbox" aria-label="Sessions">
        {visible ? <Launcher /> : null}
      </div>
    </FleetDispatchSummaryProvider>
  )
}

beforeEach(() => {
  useAppStore.setState({ activeOrcaProfileId: 'summary-owner-a' })
})
afterEach(() => {
  cleanup()
  useAppStore.setState({ activeOrcaProfileId: originalProfile })
})

it('keeps the summary open when its row unmounts and follows fresh job updates', async () => {
  const user = userEvent.setup()
  const rendered = render(<Fixture />)
  await user.click(screen.getByRole('button', { name: 'Open summary' }))
  expect(within(await screen.findByRole('dialog')).getByText('Working')).toBeTruthy()
  rendered.rerender(<Fixture visible={false} />)
  expect(screen.queryByRole('button', { name: 'Open summary' })).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
  rendered.rerender(
    <Fixture visible={false} runs={[{ ...run, jobs: [{ ...run.jobs[0], status: 'done' }] }]} />
  )
  expect(within(screen.getByRole('dialog')).getByText('Finished.')).toBeTruthy()
  rendered.rerender(<Fixture visible={false} runs={[]} />)
  expect(
    within(screen.getByRole('dialog')).getByText(
      'Current status is unavailable. Steps finished at last check: 1 of 1.'
    )
  ).toBeTruthy()
})

it('keeps a missing run readable while treating its saved state as unverified', async () => {
  const user = userEvent.setup()
  const rendered = render(<Fixture />)
  await user.click(screen.getByRole('button', { name: 'Open summary' }))
  rendered.rerender(<Fixture visible={false} runs={[]} />)
  const summary = screen.getByRole('dialog')
  expect(within(summary).getByText('Status unavailable')).toBeTruthy()
  expect(within(summary).queryByText('Working')).toBeNull()
})

it('closes immediately on account changes and does not reopen the old summary on return', async () => {
  const user = userEvent.setup()
  render(<Fixture />)
  await user.click(screen.getByRole('button', { name: 'Open summary' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  act(() => useAppStore.setState({ activeOrcaProfileId: 'summary-owner-b' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => useAppStore.setState({ activeOrcaProfileId: 'summary-owner-a' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('restores focus to a connected trigger when closed with Escape', async () => {
  const user = userEvent.setup()
  render(<Fixture />)
  const trigger = screen.getByRole('button', { name: 'Open summary' })
  await user.click(trigger)
  expect(screen.getByRole('dialog')).toBeTruthy()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(screen.queryByRole('dialog')).toBeNull()
})
