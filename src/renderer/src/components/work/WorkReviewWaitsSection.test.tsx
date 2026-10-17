// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OpenInPaneContext } from '@/components/open-in-pane-context'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReviewWaitItem } from '../../../../shared/artifact-review-waits'

const mocks = vi.hoisted(() => ({
  waits: {
    items: [] as ReviewWaitItem[],
    loaded: true,
    inbox: 'ok' as 'ok' | 'unavailable' | 'signed-out',
    readAt: 0
  },
  commandCenter: false,
  openPage: vi.fn(),
  openSession: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ settings: { commandCenter: mocks.commandCenter } })
}))
vi.mock('./use-review-waits', () => ({
  useReviewWaits: () => ({
    ...mocks.waits,
    status:
      mocks.waits.inbox === 'ok'
        ? mocks.waits.items.length
          ? 'healthy'
          : 'healthy-empty'
        : mocks.waits.inbox,
    issue: mocks.waits.inbox === 'ok' ? null : mocks.waits.inbox,
    lastSuccessAt: null
  })
}))
vi.mock('@/components/artifacts/artifact-link-actions', () => ({
  openArtifactInBrowser: mocks.openPage
}))
vi.mock('@/lib/open-linked-session', () => ({ openLinkedSession: mocks.openSession }))

const { WorkReviewWaitsSection } = await import('./WorkReviewWaitsSection')

afterEach(cleanup)

const NOW = Date.parse('2026-10-04T16:00:00Z')

it('lists pages waiting for a decision with where the session is, and opens page or session', () => {
  mocks.waits = {
    loaded: true,
    inbox: 'ok',
    readAt: NOW,
    items: [
      {
        slug: 'abc',
        title: 'Build the lifecycle?',
        question: 'Build Phase 1?',
        summary: 'Phase 1 lists answered pages under History.\nNothing ships before your yes.',
        shareUrl: 'https://omnios.example/a/abc',
        status: 'pending',
        revision: 2,
        updatedAt: '2026-10-04T15:00:00Z',
        publishedBy: null,
        session: {
          state: 'asleep',
          host: 'Sal’s MacBook Pro',
          at: null,
          local: true,
          ledgerId: 'als_0123456789abcdef01234567',
          paneKey: 'tab:leaf'
        }
      },
      {
        slug: 'old',
        title: 'Old ask',
        question: '',
        shareUrl: 'https://omnios.example/a/old',
        status: 'pending',
        revision: 1,
        updatedAt: '2026-09-20T15:00:00Z',
        publishedBy: { name: 'Uma', email: 'u@x.com', isYou: false },
        session: { state: 'waiting', host: 'Mac Studio', hostOnline: false, at: null, local: false }
      }
    ]
  }
  render(<WorkReviewWaitsSection />)
  expect(screen.getByText('Waiting for a decision')).toBeTruthy()
  const summary = screen.getByText(/Phase 1 lists answered pages under History/)
  expect(summary.getAttribute('title')).toContain('Nothing ships before your yes.')
  expect(screen.getByText('Asleep on Sal’s MacBook Pro')).toBeTruthy()
  expect(screen.getByText('Its computer is not checking in')).toBeTruthy()
  expect(screen.getByText('old')).toBeTruthy()
  expect(screen.getByText(/asked by Uma/)).toBeTruthy()
  fireEvent.click(screen.getAllByText('Open page')[0]!)
  expect(mocks.openPage).toHaveBeenCalledWith('https://omnios.example/a/abc')
  fireEvent.click(screen.getByText('Open session'))
  expect(mocks.openSession).toHaveBeenCalledWith({
    sessionLedgerId: 'als_0123456789abcdef01234567',
    paneKey: 'tab:leaf'
  })
})

it('shows nothing when nothing waits and OmniOS answered', () => {
  mocks.waits = { items: [], loaded: true, inbox: 'ok', readAt: NOW }
  const { container } = render(<WorkReviewWaitsSection />)
  expect(container.textContent).toBe('')
})

it('shows a status even when nothing is listed, and keeps the local pages visible', () => {
  mocks.waits = { items: [], loaded: true, inbox: 'unavailable', readAt: NOW }
  render(<WorkReviewWaitsSection />)
  expect(screen.getByRole('status').textContent).toContain('could not be refreshed')
  cleanup()
  const item: ReviewWaitItem = {
    slug: 'abc',
    title: 'Plan',
    question: '',
    shareUrl: '',
    status: '',
    revision: 1,
    updatedAt: null,
    publishedBy: null,
    session: {
      state: 'stalled',
      host: 'MacBook',
      at: null,
      local: true,
      reason: 'could not start',
      detail: 'spawn failed: a long local error that stays on this computer'
    }
  }
  mocks.waits = { items: [item], loaded: true, inbox: 'signed-out', readAt: NOW }
  render(<WorkReviewWaitsSection />)
  expect(screen.getByText(/Sign in to OmniOS/)).toBeTruthy()
  const chip = screen.getByText('Stalled: could not start')
  expect(chip.getAttribute('title')).toContain('spawn failed')
})

it.each([false, true])(
  'routes review page links with commandCenter=%s without changing session links',
  (enabled) => {
    mocks.commandCenter = enabled
    mocks.openPage.mockClear()
    mocks.openSession.mockClear()
    mocks.waits = {
      loaded: true,
      inbox: 'ok',
      readAt: NOW,
      items: [
        {
          slug: 'review',
          title: 'Review',
          question: '',
          shareUrl: 'https://omnios.example/a/review',
          status: 'pending',
          revision: 1,
          updatedAt: null,
          publishedBy: null,
          session: {
            state: 'waiting',
            host: 'Studio',
            at: null,
            local: true,
            ledgerId: 'als_0123456789abcdef01234567'
          }
        }
      ]
    }
    const open = vi.fn()
    render(
      <OpenInPaneContext.Provider value={open}>
        <WorkReviewWaitsSection />
      </OpenInPaneContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open page' }))
    expect(enabled ? open : mocks.openPage).toHaveBeenCalledWith('https://omnios.example/a/review')
    expect(enabled ? mocks.openPage : open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(mocks.openSession).toHaveBeenCalledOnce()
  }
)

it('shows an empty pane explicitly while keeping the full-page empty behavior', () => {
  mocks.waits = { items: [], loaded: true, inbox: 'ok', readAt: NOW }
  const { container, rerender } = render(<WorkReviewWaitsSection />)
  expect(container.childElementCount).toBe(0)
  rerender(<WorkReviewWaitsSection embedded />)
  expect(screen.getByRole('status').textContent).toContain('No pages are waiting')
})
