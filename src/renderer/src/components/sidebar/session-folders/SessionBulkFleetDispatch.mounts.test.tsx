// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionBulkFleetDispatch } from './SessionBulkFleetDispatch'
import type { SessionBulkItem } from './SessionBulkNextStep'

/**
 * Why this test exists: bulk Runs on used to hang the legacy FleetDispatchPlan → NextStepPanel
 * editor under the same Session-details control that the single session opens the folded
 * RunsOnDispatch body from — two different UIs behind one button. It renders the REAL body here.
 */
const fleet = vi.hoisted(() => ({
  read: vi.fn(() => ({
    inventory: null,
    onMachineChange: vi.fn(),
    onPrepare: vi.fn(),
    onDispatch: vi.fn(),
    recipients: { agents: { phase: 'ready', value: [{ id: 'claude', label: 'Claude' }] } }
  }))
}))
vi.mock('@/components/next-step/use-fleet-dispatch', () => ({ useFleetDispatch: fleet.read }))
vi.mock('@/components/next-step/use-next-step-task', () => ({
  useNextStepTask: () => ({ linked: null, deliverables: [] })
}))
vi.mock('@/components/next-step/use-next-step-recipients', () => ({
  useNextStepRecipients: () => ({
    agents: { phase: 'ready', value: [{ id: 'claude', label: 'Claude' }] }
  })
}))
vi.mock('@/store/conversation-fleet-store', () => ({ useConversationFleetRuns: () => {} }))
vi.mock('@/components/next-action/use-session-details-facts', () => ({
  useSessionDetailsFacts: () => ({ runsOn: 'This Mac' })
}))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => null }))
vi.mock('@/components/next-action/advanced/SessionDetailsConnected', () => ({
  SessionDetailsConnected: ({ runsOnMenu }: { runsOnMenu: React.ReactNode }) => (
    <section>{runsOnMenu}</section>
  )
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const items = [
  { key: 'row', label: 'Work', session: { rowKey: 'row', agent: 'claude' } } as SessionBulkItem
]

it('loads the bulk dispatch body only after Session details Runs on opens', () => {
  render(<SessionBulkFleetDispatch items={items} onFinished={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Session details' })).toBeTruthy()
  expect(screen.queryByRole('menu', { name: 'Run on' })).toBeNull()
  expect(fleet.read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Runs on' }))
  expect(screen.getByRole('menu', { name: 'Run on' })).toBeTruthy()
})

it('gives bulk Runs on the same location controls as one session, not the retired plan editor', () => {
  render(<SessionBulkFleetDispatch items={items} onFinished={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Runs on' }))
  // The folded RunsOnDispatch body: MenuTargets' own computers, chosen by location only.
  expect(screen.getByText('My computers · only you see these')).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: /^This (Mac|computer)/ })).toBeTruthy()
  // Why: brief 54 retires these labels with NextStepPanel; nothing may reach them from here.
  expect(screen.queryByText(/Who gets this next/)).toBeNull()
  expect(screen.queryByText('Review dispatch')).toBeNull()
  expect(screen.queryByText('Fleet dispatch plan')).toBeNull()
})
