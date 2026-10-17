// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EvolveDecisionCard } from './EvolveDecisionCard'
import { evolveRunFixture } from './evolve-run.fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

afterEach(cleanup)

it('claims no promotion and offers no local promote before OmniOS has the decision', () => {
  // The fixture's promotion gate failed its intervals check.
  render(<EvolveDecisionCard run={evolveRunFixture({ state: 'done' })} />)
  expect(screen.getByText(/Recommended: keep the current incumbent/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Promote|Keep current/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open in Decisions' })).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('Not in OmniOS Decisions yet')
  expect(screen.queryByText('Winner Promoted')).toBeNull()
})

it('opens the published OmniOS page and shows only the recorded state', () => {
  const openUrl = vi.fn()
  Object.assign(window, { api: { shell: { openUrl } } })
  const run = {
    ...evolveRunFixture({ state: 'done' }),
    decision: {
      runId: 'evo_1',
      kind: 'evolve' as const,
      winnerCandidateId: 'cand_best',
      winnerDigest: 'p1',
      idempotencyKey: 'evolve:evo_1:p1',
      decisionId: 'dec_evo_1_p1',
      state: 'published' as const,
      url: 'https://omnios.example/a/evolve',
      blindAuditPassed: true,
      updatedAt: '2026-10-16T11:00:00.000Z'
    }
  }
  render(<EvolveDecisionCard run={run} />)
  expect(screen.getByText('Published in Decisions')).toBeInTheDocument()
  expect(screen.getByText('Recommended: promote winning version cand_best.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open in Decisions' }))
  expect(openUrl).toHaveBeenCalledWith('https://omnios.example/a/evolve')
})
