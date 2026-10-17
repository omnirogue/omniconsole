// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildReviewReviewerSettings, type ReviewerSeat } from './BuildReviewReviewerSettings'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))
vi.mock('./BuildReviewAgentFields', () => ({
  BuildReviewAgentFields: ({
    label,
    capabilityMode,
    helpText
  }: {
    label: string
    capabilityMode?: string
    helpText?: string | null
  }) => (
    <span
      data-testid="reviewer-field"
      data-mode={capabilityMode}
      data-help={helpText === null ? 'hidden' : 'shown'}
    >
      {label}
    </span>
  )
}))

afterEach(cleanup)

function renderHelp(reviewersRunTogether?: boolean): string {
  return renderToStaticMarkup(
    <BuildReviewReviewerSettings
      worktree=""
      seats={[
        { id: 1, choice: { agent: 'codex' } },
        { id: 2, choice: { agent: 'claude' } }
      ]}
      onChange={() => {}}
      maxRounds={1}
      onRoundsChange={() => {}}
      {...(reviewersRunTogether === undefined ? {} : { reviewersRunTogether })}
    />
  )
}

describe('BuildReviewReviewerSettings help', () => {
  it('says Build + Review reviewers check at the same time', () => {
    expect(renderHelp()).toContain('Selected reviewers check the same change at the same time.')
  })

  it('says Next actions reviewers check at the same time', () => {
    const markup = renderHelp(true)
    expect(markup).toContain('Selected reviewers check the same change at the same time')
    expect(markup).not.toContain('in order')
  })
})

function Harness({
  initial,
  compact
}: {
  initial: ReviewerSeat[]
  compact?: boolean
}): React.JSX.Element {
  const [seats, setSeats] = useState(initial)
  const [rounds, setRounds] = useState(3)
  return (
    <>
      <BuildReviewReviewerSettings
        worktree="id:folder:notes"
        seats={seats}
        onChange={setSeats}
        maxRounds={rounds}
        onRoundsChange={setRounds}
        maxReviewers={5}
        maxRoundsLimit={5}
        compact={compact}
      />
      <output aria-label="Review plan">{JSON.stringify({ seats, rounds })}</output>
    </>
  )
}

const plan = () =>
  JSON.parse(screen.getByLabelText('Review plan').textContent!) as {
    seats: ReviewerSeat[]
    rounds: number
  }

describe('review count shortcuts', () => {
  it('selects several reviewers and rounds in one click each without rewriting existing settings', () => {
    const first = { id: 7, choice: { agent: 'claude', model: 'opus', effort: 'high' } }
    render(<Harness initial={[first]} />)

    fireEvent.click(screen.getByRole('button', { name: '5 reviewer(s)' }))
    expect(plan().seats).toHaveLength(5)
    expect(plan().seats[0]).toEqual(first)
    expect(new Set(plan().seats.map((seat) => seat.id)).size).toBe(5)
    expect(screen.getByRole('button', { name: '5 reviewer(s)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: '2 round(s)' }))
    expect(plan().rounds).toBe(2)
    expect(screen.getByLabelText('Maximum review rounds')).toHaveValue(2)

    fireEvent.click(screen.getByRole('button', { name: '1 reviewer(s)' }))
    expect(plan().seats).toEqual([first])
    expect(screen.queryByRole('button', { name: '6 reviewer(s)' })).toBeNull()
    expect(screen.queryByRole('button', { name: '6 round(s)' })).toBeNull()
  })

  it('can add reviewers to an empty selection using finite stable identities', () => {
    render(<Harness initial={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }))
    expect(plan().seats).toEqual([{ id: 0, choice: { agent: 'codex' } }])
    fireEvent.click(screen.getByRole('button', { name: '3 reviewer(s)' }))
    expect(plan().seats.map((seat) => seat.id)).toEqual([0, 1, 2])
    // Without a host proposer each added seat is a distinct lineage and no invented model.
    expect(plan().seats.map((seat) => seat.choice.agent)).toEqual(['codex', 'claude', 'grok'])
    expect(plan().seats.every((seat) => seat.choice.model === undefined)).toBe(true)
  })
})

it('passes continuation authority to every reviewer field in Next outcomes', () => {
  render(
    <BuildReviewReviewerSettings
      worktree="id:folder:linked"
      seats={[
        { id: 0, choice: { agent: 'codex' } },
        { id: 1, choice: { agent: 'claude' } }
      ]}
      onChange={vi.fn()}
      maxRounds={1}
      onRoundsChange={vi.fn()}
      capabilityMode="task-continuation"
    />
  )
  expect(
    screen.getAllByTestId('reviewer-field').map((field) => field.getAttribute('data-mode'))
  ).toEqual(['task-continuation', 'task-continuation'])
})

describe('the compact Build + Review setup', () => {
  it('offers one control for the reviewer count and one for the rounds', () => {
    render(<Harness initial={[{ id: 0, choice: { agent: 'claude' } }]} compact />)
    expect(screen.getByRole('group', { name: 'Reviewers' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Maximum review rounds' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add reviewer' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove reviewer/ })).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.getByText(/stops as soon as everyone approves/)).toBeInTheDocument()
    expect(
      screen.getAllByTestId('reviewer-field').map((field) => field.getAttribute('data-help'))
    ).toEqual(['hidden'])
  })

  it('grows and shrinks the seats from the end and sets the rounds in one click', () => {
    const first = { id: 7, choice: { agent: 'claude', model: 'opus' } }
    render(<Harness initial={[first]} compact />)
    fireEvent.click(screen.getByRole('button', { name: '3 reviewer(s)' }))
    expect(plan().seats).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '1 reviewer(s)' }))
    expect(plan().seats).toEqual([first])
    fireEvent.click(screen.getByRole('button', { name: '4 round(s)' }))
    expect(plan().rounds).toBe(4)
    expect(screen.getByRole('button', { name: '4 round(s)' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})

it('keeps per-seat removal, the rounds field and seat help for Next actions', () => {
  render(
    <Harness
      initial={[
        { id: 0, choice: { agent: 'codex' } },
        { id: 1, choice: { agent: 'claude' } }
      ]}
    />
  )
  expect(
    screen.getAllByTestId('reviewer-field').map((field) => field.getAttribute('data-help'))
  ).toEqual(['shown', 'shown'])
  fireEvent.click(screen.getByRole('button', { name: 'Remove reviewer 1' }))
  expect(plan().seats).toEqual([{ id: 1, choice: { agent: 'claude' } }])
  fireEvent.change(screen.getByLabelText('Maximum review rounds'), { target: { value: '4' } })
  expect(plan().rounds).toBe(4)
})
