// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ReviewWaitItem } from '../../../shared/artifact-review-waits'
import { getDefaultSettings } from '../../../shared/constants'

const mocks = vi.hoisted(() => ({
  enabled: true,
  needsYou: 0,
  items: [] as Pick<ReviewWaitItem, 'slug' | 'status'>[],
  reviewWaitsCalls: 0,
  openWorkDecisions: vi.fn(),
  fetch: vi.fn()
}))
vi.mock('../store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ settings: { experimentalDecisionsTitlebarBadge: mocks.enabled } })
}))
vi.mock('@/components/sidebar/WorkNeedsYouBadge', () => ({
  useWorkNeedsYouCount: () => mocks.needsYou
}))
vi.mock('@/components/work/use-review-waits', () => ({
  useReviewWaits: () => {
    mocks.reviewWaitsCalls += 1
    return { items: mocks.items }
  }
}))
vi.mock('@/lib/open-work-decisions', () => ({ openWorkDecisions: mocks.openWorkDecisions }))

const { DecisionsTitlebarBadge, countUndecidedReviewWaits } =
  await import('./DecisionsTitlebarBadge')

function renderBadge(): void {
  render(
    <TooltipProvider>
      <DecisionsTitlebarBadge />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mocks.enabled = true
  mocks.needsYou = 0
  mocks.items = []
  mocks.reviewWaitsCalls = 0
  mocks.openWorkDecisions.mockReset()
  mocks.fetch.mockReset()
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('shows 1 for one pending review wait and opens Decisions on click without deciding anything', () => {
  mocks.items = [{ slug: 'abc', status: 'pending' }]
  renderBadge()
  const badge = screen.getByRole('button', { name: 'Decisions waiting: 1' })
  expect(badge.getAttribute('data-decisions-titlebar-badge')).toBe('1')
  fireEvent.click(badge)
  expect(mocks.openWorkDecisions).toHaveBeenCalledTimes(1)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('adds the need-you count and skips pages already answered', () => {
  mocks.needsYou = 2
  mocks.items = [
    { slug: 'a', status: 'pending' },
    { slug: 'b', status: 'approved' },
    { slug: 'c', status: 'rejected' },
    { slug: 'd', status: '' }
  ]
  renderBadge()
  expect(screen.getByRole('button', { name: 'Decisions waiting: 4' })).toBeTruthy()
})

it('renders nothing when nothing waits', () => {
  mocks.items = [{ slug: 'a', status: 'changes_requested' }]
  renderBadge()
  expect(screen.queryByRole('button')).toBeNull()
})

it('stays off by default and does not read review waits while off', () => {
  expect(getDefaultSettings('/tmp').experimentalDecisionsTitlebarBadge).toBe(false)
  mocks.enabled = false
  mocks.items = [{ slug: 'abc', status: 'pending' }]
  renderBadge()
  expect(screen.queryByRole('button')).toBeNull()
  expect(mocks.reviewWaitsCalls).toBe(0)
})

it('counts only undecided pages', () => {
  expect(
    countUndecidedReviewWaits([
      { status: 'pending' },
      { status: '' },
      { status: 'approved' },
      { status: 'changes_requested' },
      { status: 'rejected' }
    ])
  ).toBe(2)
})
