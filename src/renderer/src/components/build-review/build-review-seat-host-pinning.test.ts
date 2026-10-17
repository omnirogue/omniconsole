import { expect, it, vi } from 'vitest'
import type { ReviewerSeat } from './BuildReviewReviewerSettings'
import { reconcileReviewerSeats, reviewerSeatProblem } from './build-review-seat-host-pinning'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

const model = (id: string, isDefault = false) => ({
  id,
  label: id,
  options: [],
  ...(isDefault ? { isDefault } : {})
})
const sonnetOnly = {
  id: 'claude' as const,
  label: 'Claude',
  models: [model('sonnet', true)],
  modelsProbed: true
}
const codex = {
  id: 'codex' as const,
  label: 'Codex',
  models: [model('gpt-5.5', true)],
  modelsProbed: true
}
const seats = (...choices: ReviewerSeat['choice'][]): ReviewerSeat[] =>
  choices.map((choice, id) => ({ id, choice }))

it('repins the hard-coded opus default onto the only model a Sonnet-only host lists', () => {
  const host = { agents: [sonnetOnly, codex], loading: false }
  const pinned = reconcileReviewerSeats(
    seats({ agent: 'claude', model: 'opus', effort: 'high' }),
    host
  )
  // The effort goes with the model it was chosen for; this host advertises none for sonnet.
  expect(pinned.map((seat) => seat.choice)).toEqual([{ agent: 'claude', model: 'sonnet' }])
  expect(reviewerSeatProblem(pinned, host)).toBeNull()
})

it('blocks with an actionable problem while discovery is missing, loading or refused', () => {
  const seat = seats({ agent: 'claude', model: 'opus' })
  expect(reviewerSeatProblem(seat, { agents: [], loading: true })).toMatch(/Checking which models/)
  expect(reviewerSeatProblem(seat, { agents: [], loading: false })).toMatch(
    /has not reported which agents and models/
  )
  const unprobed = { id: 'claude' as const, label: 'Claude' }
  expect(reviewerSeatProblem(seat, { agents: [unprobed], loading: false })).toMatch(
    /could not be verified/
  )
  // A seat proposed during the outage keeps no invented model, and is named rather than sent.
  expect(
    reviewerSeatProblem(seats({ agent: 'codex' }), { agents: [unprobed], loading: false })
  ).toMatch(/not available on this workspace/)
})

it('leaves seats untouched while the host is silent, and repairs them when it answers', () => {
  const outage = { agents: [], loading: false }
  const added = reconcileReviewerSeats(
    seats({ agent: 'claude', model: 'opus', effort: 'high' }, { agent: 'codex' }),
    outage
  )
  expect(added.map((seat) => seat.choice)).toEqual([
    { agent: 'claude', model: 'opus', effort: 'high' },
    { agent: 'codex' }
  ])
  const repaired = reconcileReviewerSeats(added, { agents: [sonnetOnly, codex], loading: false })
  expect(repaired.map((seat) => seat.choice)).toEqual([
    { agent: 'claude', model: 'sonnet' },
    { agent: 'codex', model: 'gpt-5.5' }
  ])
})

it('lets independent seats share the one model a single-model host lists', () => {
  const host = { agents: [sonnetOnly], loading: false }
  const pinned = reconcileReviewerSeats(seats({ agent: 'claude' }, { agent: 'claude' }), host)
  expect(pinned.map((seat) => seat.choice)).toEqual([
    { agent: 'claude', model: 'sonnet' },
    { agent: 'claude', model: 'sonnet' }
  ])
  expect(reviewerSeatProblem(pinned, host)).toBeNull()
})

it('reconciles against the selected remote host, not this computer', () => {
  const remote = {
    id: 'claude' as const,
    label: 'Claude',
    models: [model('sonnet-remote', true)],
    modelsProbed: true
  }
  const host = { agents: [remote], loading: false }
  const pinned = reconcileReviewerSeats(seats({ agent: 'claude', model: 'opus' }), host)
  expect(pinned.map((seat) => seat.choice)).toEqual([{ agent: 'claude', model: 'sonnet-remote' }])
})

it('names a model the person chose themselves instead of silently rewriting it', () => {
  const host = { agents: [sonnetOnly], loading: false }
  const chosen: ReviewerSeat[] = [
    { id: 0, choice: { agent: 'claude', model: 'opus' }, chosen: true }
  ]
  expect(reconcileReviewerSeats(chosen, host)).toEqual(chosen)
  expect(reviewerSeatProblem(chosen, host)).toMatch(/does not list/)
})

it('fills in the host default after a manual agent change cleared the model', () => {
  const host = { agents: [sonnetOnly, codex], loading: false }
  const switched: ReviewerSeat[] = [{ id: 0, choice: { agent: 'codex' }, chosen: true }]
  expect(reconcileReviewerSeats(switched, host).map((seat) => seat.choice)).toEqual([
    { agent: 'codex', model: 'gpt-5.5' }
  ])
})
