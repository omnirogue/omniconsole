import { expect, it, vi } from 'vitest'

vi.mock('./BuildReviewAgentFields', () => ({ BuildReviewAgentFields: () => null }))

const { resizeReviewerSeats } = await import('./BuildReviewReviewerSettings')

it('asks the surface for each added seat with the seats chosen so far', () => {
  const proposer = vi.fn((seats: readonly { choice: { agent: string } }[]) =>
    seats.length === 1 ? { agent: 'claude', model: 'sonnet' } : { agent: 'grok', model: 'grok-4.6' }
  )
  const seats = resizeReviewerSeats(
    [{ id: 0, choice: { agent: 'codex', model: 'gpt-5.6-sol' } }],
    3,
    proposer
  )
  expect(seats).toEqual([
    { id: 0, choice: { agent: 'codex', model: 'gpt-5.6-sol' } },
    { id: 1, choice: { agent: 'claude', model: 'sonnet' } },
    { id: 2, choice: { agent: 'grok', model: 'grok-4.6' } }
  ])
  expect(proposer).toHaveBeenCalledTimes(2)
})

it('falls back to distinct lineages with no model, never a model the host never listed', () => {
  for (const proposer of [undefined, () => null]) {
    const seats = resizeReviewerSeats(
      [{ id: 0, choice: { agent: 'claude', model: 'sonnet' } }],
      3,
      proposer
    )
    // A static catalog model here would be indistinguishable from one the host verified.
    expect(seats.map((seat) => seat.choice)).toEqual([
      { agent: 'claude', model: 'sonnet' },
      { agent: 'codex' },
      { agent: 'grok' }
    ])
  }
})
