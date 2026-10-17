// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NextStepDoneness } from '../../../../shared/next-step-doneness'
import type { NextStepSuggestionSet } from '../../../../shared/next-step-suggestions'
import { NextStepsDonenessChip } from './NextStepsDonenessChip'
import { NextStepsTrayPanel } from './NextStepsTrayPanel'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

afterEach(cleanup)

const reading = (over: Partial<NextStepDoneness> = {}): NextStepDoneness => ({
  resolved: 0.85,
  remainingWork: 0.05,
  roomToImprove: 0.1,
  verified: 0.9,
  unsure: false,
  turnKey: 't1',
  at: 1,
  ...over
})

it('shows a clear reading with every figure on hover', () => {
  render(<NextStepsDonenessChip reading={reading()} />)
  const chip = screen.getByText('≈ 85% done')
  expect(chip.getAttribute('title')).toBe(
    'resolved 85% · still missing 5% · room to improve 10% · checked 90% (JEV, advisory)'
  )
})

it('follows resolved alone: doubt in another reading keeps the chip', () => {
  render(<NextStepsDonenessChip reading={reading({ roomToImprove: 0.5, unsure: true })} />)
  expect(screen.getByText('≈ 85% done')).toBeTruthy()
})

it('shows nothing when resolved is unsure, or with no reading', () => {
  const { container } = render(
    <>
      <NextStepsDonenessChip reading={reading({ resolved: 0.5, unsure: true })} />
      <NextStepsDonenessChip reading={null} />
      <NextStepsDonenessChip reading={undefined} />
    </>
  )
  expect(container.querySelector('[data-next-steps-doneness]')).toBeNull()
})

it('sits in the tray header beside the count', () => {
  const set: NextStepSuggestionSet = {
    id: 'ai-1',
    worktreeId: 'wt',
    turnKey: 't1',
    origin: 'ai',
    createdAt: 1,
    status: 'pending',
    suggestions: [
      { id: 'a', title: 'Run tests', prompt: 'Run tests.', risk: 'safe', kind: 'verify' }
    ]
  }
  const actions = { run: vi.fn(), save: vi.fn(), dismiss: vi.fn(), suggest: vi.fn() }
  render(
    <NextStepsTrayPanel
      set={set}
      suggestions={set.suggestions}
      thinking={false}
      failure={null}
      suggesting={false}
      actions={actions}
      onError={vi.fn()}
      doneness={reading({ resolved: 0.97 })}
    />
  )
  expect(screen.getByText('≈ 97% done')).toBeTruthy()
})
