// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionStatistics } from '@/lib/session-statistics'
const mocks = vi.hoisted(() => ({
  state: {
    settings: { commandCenter: false },
    sshTargetLabels: new Map(),
    runtimeEnvironments: []
  },
  read: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: typeof mocks.state) => unknown) => select(mocks.state)
}))
vi.mock('../artifacts/ArtifactsPage', () => ({
  default: ({ embedded }: { embedded: boolean }) => (
    <div>Artifacts embedded: {String(embedded)}</div>
  )
}))
vi.mock('../work/WorkReviewWaitsSection', () => ({
  WorkReviewWaitsSection: ({ embedded }: { embedded: boolean }) => (
    <div>Review waits embedded: {String(embedded)}</div>
  )
}))
vi.mock('./OmniOSDecisionsPane', () => ({
  OmniOSDecisionsPane: () => null,
  OMNIOS_DECISIONS_VIEW_ID: 'omnios-decisions'
}))
vi.mock('./use-session-statistics-snapshot', () => ({ useSessionStatisticsSnapshot: mocks.read }))
import {
  ArtifactsPaneBody,
  ReviewWaitsPaneBody,
  SessionStatisticsPaneBody,
  ARTIFACTS_VIEW_ID,
  REVIEW_WAITS_VIEW_ID,
  SESSION_STATISTICS_VIEW_ID,
  OMNIOS_DECISIONS_VIEW_ID
} from './needs-you-pane-bodies'
afterEach(cleanup)

it('exports distinct stable ids without registering grid content', () => {
  expect([
    ARTIFACTS_VIEW_ID,
    REVIEW_WAITS_VIEW_ID,
    SESSION_STATISTICS_VIEW_ID,
    OMNIOS_DECISIONS_VIEW_ID
  ]).toEqual(['artifacts', 'review-waits', 'session-statistics', 'omnios-decisions'])
})

it('mounts no pane body or statistics reader with the setting off', () => {
  mocks.state.settings.commandCenter = false
  mocks.read.mockClear()
  const { container } = render(
    <>
      <ArtifactsPaneBody />
      <ReviewWaitsPaneBody />
      <SessionStatisticsPaneBody />
    </>
  )
  expect(container.childElementCount).toBe(0)
  expect(mocks.read).not.toHaveBeenCalled()
})

it('mounts embedded bodies with the setting on', () => {
  mocks.state.settings.commandCenter = true
  mocks.read.mockReturnValue({
    data: sessionStatistics([], Date.now()),
    status: 'healthy-empty',
    issue: null,
    lastSuccessAt: null,
    readAt: Date.now(),
    error: null
  })
  render(
    <>
      <ArtifactsPaneBody />
      <ReviewWaitsPaneBody />
      <SessionStatisticsPaneBody />
    </>
  )
  expect(screen.getByText('Artifacts embedded: true')).toBeTruthy()
  expect(screen.getByText('Review waits embedded: true')).toBeTruthy()
  expect(screen.getByText('No sessions are listed.')).toBeTruthy()
})
