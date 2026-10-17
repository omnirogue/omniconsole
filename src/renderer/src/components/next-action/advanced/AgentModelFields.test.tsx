// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentModelFields } from './AgentModelFields'
import { agentFixture, upNextFixture } from '../up-next-fixture'
vi.mock('@/components/build-review/BuildReviewAgentFields', () => ({
  BuildReviewModelEffortFields: () => null
}))
vi.mock('@/components/status-bar/use-usage-providers', () => ({
  useUsageProviders: () => ({ providers: [] })
}))
vi.mock('@/components/session-team/use-session-source-actor', () => ({
  useSessionSourceActor: () => ({ agent: 'claude' })
}))
afterEach(cleanup)
it('says what the one model/effort applies to without blaming the host (S-7)', () => {
  render(
    <AgentModelFields
      block={agentFixture('stage', { n: 3 })}
      view={upNextFixture()}
      onChange={vi.fn()}
    />
  )
  expect(
    screen.getByText(
      'Applies to every seat in this stage. Per-seat model and effort are not authored here yet.'
    )
  ).toBeTruthy()
  // The engine already carries per-seat actors (`WorkPlanWorkerNode.seats`); the missing
  // piece is the Up next authoring contract, so the copy must not blame the host.
  expect(screen.queryByText(/host contract/)).toBeNull()
})
it('says nothing about seats for a single-seat stage', () => {
  render(
    <AgentModelFields block={agentFixture('stage')} view={upNextFixture()} onChange={vi.fn()} />
  )
  expect(screen.queryByText(/every seat/)).toBeNull()
})
