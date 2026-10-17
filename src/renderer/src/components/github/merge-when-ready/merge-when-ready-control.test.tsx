// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { MergeWhenReadyPullRequestFacts } from '../../../../../shared/github/merge-when-ready-facts'
import type { MergeWhenReadyClient } from './merge-when-ready-actions'
import { MergeWhenReadyControl } from './merge-when-ready-control'
import type { MergeWhenReadyState } from './use-merge-when-ready'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  recordFeatureInteraction: vi.fn()
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: mocks.recordFeatureInteraction }) }
}))

const BOX = '- [ ] **Merge when ready** (Sal or Uma: tick to merge)'
const TICKED = '- [x] **Merge when ready** (Sal or Uma: tick to merge)'

function facts(overrides: Partial<MergeWhenReadyPullRequestFacts> = {}) {
  return {
    number: 8,
    title: 'Fix refunds',
    body: `${BOX}\n\nBody`,
    state: 'open',
    isDraft: false,
    url: 'https://github.com/acme/omni/pull/8',
    author: 'opener',
    createdAt: '2026-10-12T09:00:00Z',
    baseRefName: 'prod-omnirogue',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [],
    checks: [],
    labelEvents: [],
    titleEvents: [],
    olderEventsOmitted: false,
    ...overrides
  } satisfies MergeWhenReadyPullRequestFacts
}

function setup(
  initial: MergeWhenReadyPullRequestFacts | null,
  error: string | null = null,
  onGitHub: MergeWhenReadyPullRequestFacts | null = initial
) {
  let current = onGitHub
  const writes: string[] = []
  const client: MergeWhenReadyClient = {
    readFacts: async () => ({ pullRequests: current ? [current] : [], missing: [] }),
    updatePullRequest: async (_number, updates) => {
      writes.push(JSON.stringify(updates))
      current = current ? { ...current, ...updates } : current
    },
    removeLabels: async (_number, labels) => {
      writes.push(`unlabel ${labels.join(',')}`)
      current = current ? { ...current, labels: [] } : current
    }
  }
  const state: MergeWhenReadyState = {
    number: 8,
    client,
    facts: initial,
    error,
    loaded: true,
    boxPresent: true,
    refresh: vi.fn()
  }
  const onMutated = vi.fn()
  render(
    <TooltipProvider>
      <MergeWhenReadyControl state={state} onMutated={onMutated} />
    </TooltipProvider>
  )
  return { writes, state, onMutated, user: userEvent.setup() }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('ticks the box in one click and says what it is waiting on', async () => {
  const { writes, state, onMutated, user } = setup(
    facts({ isDraft: true, checks: [{ name: 'Tests', state: 'pending' }] })
  )

  expect(
    screen.getByText('Waiting on: draft (the job marks it ready) · running: Tests')
  ).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Merge when ready' }))

  await waitFor(() =>
    expect(mocks.toast.success).toHaveBeenCalledWith('Merge when ready is on for PR #8.')
  )
  expect(writes).toEqual([JSON.stringify({ body: `${TICKED}\n\nBody` })])
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.recordFeatureInteraction).toHaveBeenCalledWith('github-tasks')
  expect(onMutated).toHaveBeenCalledTimes(1)
  expect(state.refresh).toHaveBeenCalledTimes(1)
})

it('shows who held a PR and writes nothing unless the hold is lifted', async () => {
  mocks.confirm.mockResolvedValue(false)
  const { writes, user } = setup(
    facts({
      labels: ['do-not-merge'],
      labelEvents: [{ label: 'do-not-merge', login: 'uma', at: '2026-10-12T11:00:00Z' }]
    })
  )

  expect(screen.getByText('Held')).toBeTruthy()
  expect(screen.getByText(/"do-not-merge" label, set by uma on/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Merge when ready' }))

  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
  expect(mocks.confirm.mock.calls[0][0]).toMatchObject({
    title: 'Lift the hold on PR #8?',
    confirmLabel: 'Lift hold and merge when ready'
  })
  expect(writes).toEqual([])
})

it('lifts the hold and ticks the box once the person confirms', async () => {
  mocks.confirm.mockResolvedValue(true)
  const { writes, user } = setup(facts({ labels: ['do-not-merge'] }))

  await user.click(screen.getByRole('button', { name: 'Merge when ready' }))

  await waitFor(() =>
    expect(mocks.toast.success).toHaveBeenCalledWith('Merge when ready is on for PR #8.')
  )
  expect(writes).toEqual([JSON.stringify({ body: `${TICKED}\n\nBody` }), 'unlabel do-not-merge'])
})

it('writes nothing when a hold was set after the confirm was shown', async () => {
  mocks.confirm.mockResolvedValue(true)
  const shown = facts({ labels: ['do-not-merge'] })
  const { writes, user } = setup(shown, null, { ...shown, title: 'Fix refunds [DO NOT MERGE YET]' })

  await user.click(screen.getByRole('button', { name: 'Merge when ready' }))

  await waitFor(() =>
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'PR #8 was put on hold after this view loaded. Check the hold, then click again.'
    )
  )
  expect(writes).toEqual([])
})

it('shows an armed PR as on, with a Stop that unticks the box', async () => {
  const { writes, user } = setup(facts({ body: `${TICKED}\n\nBody` }))

  expect(screen.getByText('Merge when ready is on')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Stop' }))

  await waitFor(() =>
    expect(mocks.toast.success).toHaveBeenCalledWith('Merge when ready is off for PR #8.')
  )
  expect(writes).toEqual([JSON.stringify({ body: `${BOX}\n\nBody` })])
})

it('says when it could not check, with a retry', async () => {
  const { state, user } = setup(null, 'GitHub is down')

  await user.click(screen.getByRole('button', { name: 'Retry' }))

  expect(screen.getByText("Couldn't check Merge when ready.")).toBeTruthy()
  expect(state.refresh).toHaveBeenCalledTimes(1)
})

it('renders nothing for a PR without the box', () => {
  const { container } = render(
    <TooltipProvider>
      <MergeWhenReadyControl
        state={{
          number: 8,
          client: null,
          facts: facts({ body: 'no box' }),
          error: null,
          loaded: true,
          boxPresent: false,
          refresh: vi.fn()
        }}
        onMutated={vi.fn()}
      />
    </TooltipProvider>
  )

  expect(container.textContent).toBe('')
})
