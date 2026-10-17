import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeAttempt,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'
import {
  consumeVerdictForStep,
  setSessionOutcomeVerdictConsumer,
  setSessionOutcomeVerdictInstructions,
  verdictInstructionsFor
} from './session-outcome-verdict-hook'

const step = {
  id: 'judge',
  agent: 'codex',
  prompt: 'Pick the winner',
  status: 'queued',
  verdict: { kind: 'judge', over: ['a', 'b'], consumed: 'select-winner' }
} as SessionChainAgentStep

const outcome = { id: 'ship', conditions: [] } as unknown as SessionOutcome
const attempt = { id: 'attempt_1', actionId: 'step_judge' } as SessionOutcomeAttempt

function access() {
  let chain = {
    id: 'chain',
    steps: [step],
    outcomeSet: {
      outcomes: [{ ...outcome, status: 'pending' }],
      attempts: [],
      continuation: {},
      revision: 1
    } as unknown as SessionOutcomeSet
  } as unknown as SessionChain
  return {
    runtime: {} as never,
    read: () => chain,
    save: (updated: SessionChain) => {
      chain = updated
    },
    persistAttempt: () => {},
    current: () => chain
  }
}

afterEach(() => {
  setSessionOutcomeVerdictConsumer(null)
  setSessionOutcomeVerdictInstructions(null)
})

describe('the seam the verdict package wires into', () => {
  it('changes nothing at all while nobody is wired in', async () => {
    const seat = access()
    expect(await consumeVerdictForStep(seat, seat.current(), outcome, step, attempt)).toBe(
      'unwired'
    )
    expect(verdictInstructionsFor(step, outcome)).toBe('')
    expect(seat.current().outcomeSet!.outcomes[0]!.status).toBe('pending')
  })

  it('spends a completed seat verdict exactly once, with its own attempt and the pass clock', async () => {
    const consumer = vi.fn(async () => 'applied' as const)
    setSessionOutcomeVerdictConsumer(consumer)
    const seat = access()

    expect(await consumeVerdictForStep(seat, seat.current(), outcome, step, attempt, 1_234)).toBe(
      'applied'
    )
    expect(consumer).toHaveBeenCalledTimes(1)
    // The receipt is stamped on the pass's one clock, never a second reading of the wall clock.
    expect(consumer.mock.calls[0]!.slice(2)).toEqual([outcome, step, attempt, 1_234])
  })

  it('blocks the outcome when the verdict could not be trusted, and not when it replays', async () => {
    setSessionOutcomeVerdictConsumer(async () => 'replayed')
    const replay = access()
    await consumeVerdictForStep(replay, replay.current(), outcome, step, attempt)
    expect(replay.current().outcomeSet!.outcomes[0]!.status).toBe('pending')

    setSessionOutcomeVerdictConsumer(async () => 'failed')
    const refused = access()
    await consumeVerdictForStep(refused, refused.current(), outcome, step, attempt)
    expect(refused.current().outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'The verdict from judge could not be consumed.'
    })
  })

  it('never consumes a seat that emits no verdict', async () => {
    const consumer = vi.fn(async () => 'applied' as const)
    setSessionOutcomeVerdictConsumer(consumer)
    const plain = { ...step, verdict: undefined } as SessionChainAgentStep
    const seat = access()

    expect(await consumeVerdictForStep(seat, seat.current(), outcome, plain, attempt)).toBe(
      'unwired'
    )
    expect(consumer).not.toHaveBeenCalled()
  })
})

describe('the marker instructions a verdict seat ends with', () => {
  it('is built for every verdict kind, over the seats it judges', () => {
    setSessionOutcomeVerdictInstructions(
      (seat, candidates) =>
        `END WITH A ${seat.verdict!.kind.toUpperCase()} OVER ${candidates.join()}`
    )
    expect(verdictInstructionsFor(step, outcome)).toBe('END WITH A JUDGE OVER a,b')
    const critic = {
      ...step,
      verdict: { ...step.verdict!, kind: 'critique' }
    } as SessionChainAgentStep
    expect(verdictInstructionsFor(critic, outcome)).toBe('END WITH A CRITIQUE OVER a,b')
  })

  it('adds nothing to a seat that emits no verdict', () => {
    setSessionOutcomeVerdictInstructions(() => 'MARKER')
    expect(
      verdictInstructionsFor({ ...step, verdict: undefined } as SessionChainAgentStep, outcome)
    ).toBe('')
  })
})
