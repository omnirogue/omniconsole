/**
 * The first step of a chain waits for the conversation it reads to finish its turn.
 *
 * `continuation.sourceReady` is sticky: it records that the source went idle once. A person
 * who keeps typing — or who composes a new plan version mid-turn — would otherwise have an
 * unfinished turn read as the starting state. An unreadable source is a different thing and
 * is left to the continuation's own unverifiable state.
 */
import { describe, expect, it, vi } from 'vitest'

const source = vi.hoisted(() => ({ ready: true, unverifiable: false as boolean | undefined }))
vi.mock('./session-outcome-source', () => ({
  observeSessionOutcomeSource: async () => ({
    ready: source.ready,
    ...(source.unverifiable ? { unverifiable: true } : {})
  })
}))
const mocks = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('./session-outcome-step-brief', () => ({
  prepareOutcomeStep: () => ({ action: { id: 'step_a' }, launch: mocks.launch })
}))
vi.mock('./session-outcome-executor', () => ({ sessionOutcomeExecutionBrief: () => 'brief' }))
vi.mock('./session-outcome-candidate', () => ({
  sessionOutcomeCandidatePaths: () => [],
  sessionOutcomeCandidateVersion: async () => 'candidate-1'
}))

import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcome } from '../../shared/session-outcome-types'
import { launchStepCohort } from './session-outcome-step-cohort'
import type { OutcomeStepAccess } from './session-outcome-step-progress'

function world(steps: SessionChainAgentStep[], over: Partial<SessionChain> = {}) {
  const outcome = {
    id: 'ship',
    title: 'Ship it',
    finish: 'complete',
    dependsOn: [],
    conditions: [],
    actions: [],
    stepIds: steps.map((step) => step.id),
    revision: 1,
    status: 'pending',
    evidence: []
  } as unknown as SessionOutcome
  let chain = {
    id: 'chain',
    workspacePath: '/w',
    sourcePaneKey: 'tab-1:leaf-1',
    steps,
    outcomeSet: {
      outcomes: [outcome],
      attempts: [],
      completedSteps: [],
      continuation: { sourceReady: true },
      revision: 1
    },
    ...over
  } as unknown as SessionChain
  const access = {
    runtime: {} as never,
    read: () => chain,
    save: (next: SessionChain) => {
      chain = next
    },
    persistAttempt: () => {}
  } as unknown as OutcomeStepAccess
  return { access, chain: () => chain, outcome }
}

const step = (id: string, over: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep =>
  ({
    id,
    outcomeId: 'ship',
    agent: 'codex',
    prompt: `do ${id}`,
    status: 'queued',
    ...over
  }) as SessionChainAgentStep

describe('admitting the first step of a chain', () => {
  it('holds it while the conversation it reads is still working', async () => {
    source.ready = false
    source.unverifiable = false
    mocks.launch.mockClear()
    const { access, chain } = world([step('a')])

    const result = await launchStepCohort(
      access,
      chain(),
      { id: 'ship' } as SessionOutcome,
      step('a'),
      8
    )

    expect(result).toEqual({ launched: [], waiting: ['a'] })
    expect(mocks.launch).not.toHaveBeenCalled()
    expect((chain().steps[0] as SessionChainAgentStep).wait).toMatchObject({
      reason: 'dependency',
      ref: 'tab-1:leaf-1'
    })
  })

  it('admits it once that turn has finished', async () => {
    source.ready = true
    mocks.launch.mockClear()
    const { access, chain, outcome } = world([step('a')])

    const result = await launchStepCohort(access, chain(), outcome, step('a'), 8)

    expect(result).toEqual({ launched: ['a'], waiting: [] })
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })

  it('does not hold work already under way for a source it cannot read', async () => {
    source.ready = false
    source.unverifiable = true
    mocks.launch.mockClear()
    const { access, chain, outcome } = world([step('a', { status: 'launched' }), step('b')])

    const result = await launchStepCohort(access, chain(), outcome, step('b'), 8)

    expect(result.launched).toEqual(['b'])
  })
})
