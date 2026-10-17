import { describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type {
  SessionOutcomeAction,
  SessionOutcomeAttempt,
  SessionOutcomeDefinition,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  advance: vi.fn(async () => ({ acted: false, launched: 0 })),
  brief: vi.fn(() => 'brief')
}))
// #283 (7c2c01d48, carried into the parallel launcher by merge b611dacbc) refuses an oversized
// brief before a launch takes a slot; without this export that guard throws on every action.
vi.mock('./session-outcome-executor', () => ({
  launchSessionOutcomeAction: mocks.launch,
  sessionOutcomeExecutionBrief: mocks.brief
}))
vi.mock('./session-outcome-steps', () => ({ advanceSessionOutcomeSteps: mocks.advance }))

import { launchSessionOutcomeWork, sessionOutcomeSlots } from './session-outcome-concurrency'
import { SessionOutcomeBriefTooLargeError } from './session-outcome-attempt-failure'

function outcome(id: string): SessionOutcomeDefinition {
  return {
    id,
    title: id,
    finish: 'complete',
    dependsOn: [],
    conditions: [],
    actions: [
      {
        id: `write_${id}`,
        instruction: id,
        conditionIds: [],
        authority: 'existing-user-authority',
        agent: 'codex'
      }
    ],
    revision: 1,
    status: 'pending',
    evidence: []
  } as unknown as SessionOutcomeDefinition
}

function chainOf(ids: string[]): SessionChain {
  return {
    steps: [],
    parallelOutcomeIds: ids,
    outcomeSet: {
      outcomes: ids.map(outcome),
      attempts: [],
      completedSteps: [],
      continuation: {},
      revision: 1
    } as unknown as SessionOutcomeSet
  } as unknown as SessionChain
}

function access(chain: SessionChain) {
  return {
    runtime: {} as never,
    read: () => chain,
    save: () => {},
    persistAttempt: () => {}
  }
}

/** Holds the named outcome's launch open until it is released. */
function heldLaunch(held: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.launch.mockImplementation(
    async (_runtime: unknown, _chain: SessionChain, id: string, action: SessionOutcomeAction) => {
      if (id === held) {
        await gate
      }
      return { id: `attempt_${id}`, outcomeId: id, actionId: action.id }
    }
  )
  return release
}

describe('authorized slots', () => {
  it('does not free a slot while its worker is only unverifiable', () => {
    const attempt = {
      id: 'attempt_one',
      outcomeId: 'one',
      actionId: 'write_one',
      actionKey: 'key',
      outcomeRevision: 1,
      state: 'unverifiable',
      launchDisposition: 'unverifiable',
      taskId: 'task_one',
      dispatchId: 'dispatch_one',
      startedAt: 1,
      updatedAt: 1
    } satisfies SessionOutcomeAttempt
    const chain = {
      parallelOutcomeIds: ['one', 'two'],
      outcomeSet: { continuation: {}, attempts: [attempt] }
    } as unknown as SessionChain

    // Lost contact is not proof the agent exited, and an extra launch cannot be taken back.
    expect(sessionOutcomeSlots({ getOutcomeChainMaxConcurrentAgents: () => 1 }, chain)).toBeNull()
    expect(
      sessionOutcomeSlots({ getOutcomeChainMaxConcurrentAgents: () => 2 }, chain)?.inFlight
    ).toEqual([attempt])
  })

  it('holds an unverifiable slot on a card continuation too', () => {
    const chain = {
      outcomeSet: {
        continuation: { taskId: 'btk_1' },
        attempts: [{ id: 'a', outcomeId: 'one', state: 'unverifiable' }]
      }
    } as unknown as SessionChain

    expect(sessionOutcomeSlots({ getOutcomeChainMaxConcurrentAgents: () => 3 }, chain)).toBeNull()
  })
})

describe('independent outcome actions', () => {
  it('starts the second authorized action before the first slow launch returns', async () => {
    mocks.advance.mockResolvedValue({ acted: false, launched: 0 })
    const release = heldLaunch('one')
    const chain = chainOf(['one', 'two'])

    const running = launchSessionOutcomeWork(access(chain), {
      limit: 2,
      parallel: new Set(['one', 'two']),
      inFlight: []
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const startedWhileFirstHeld = mocks.launch.mock.calls.length
    release()
    await running

    expect(startedWhileFirstHeld).toBe(2)
  })

  it('never starts more actions than the limit authorizes', async () => {
    mocks.advance.mockResolvedValue({ acted: false, launched: 0 })
    mocks.launch.mockReset()
    const release = heldLaunch('one')
    const chain = chainOf(['one', 'two', 'three'])

    const running = launchSessionOutcomeWork(access(chain), {
      limit: 2,
      parallel: new Set(['one', 'two', 'three']),
      inFlight: []
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const startedWhileFirstHeld = mocks.launch.mock.calls.length
    release()
    await running

    expect(startedWhileFirstHeld).toBe(2)
    expect(mocks.launch.mock.calls).toHaveLength(2)
  })

  it('waits for every launch it started before the tick ends', async () => {
    mocks.advance.mockResolvedValue({ acted: false, launched: 0 })
    mocks.launch.mockReset()
    let settled = 0
    mocks.launch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      settled += 1
    })

    await launchSessionOutcomeWork(access(chainOf(['one', 'two'])), {
      limit: 2,
      parallel: new Set(['one', 'two']),
      inFlight: []
    })

    // Otherwise the next tick would read no attempt and launch the same action again.
    expect(settled).toBe(2)
  })

  it('records a refused action as an attempt of its own and still starts its sibling', async () => {
    mocks.advance.mockResolvedValue({ acted: false, launched: 0 })
    mocks.launch.mockReset()
    mocks.launch.mockResolvedValue(undefined)
    mocks.brief.mockImplementationOnce(() => {
      throw new SessionOutcomeBriefTooLargeError(
        'The full Next launch context is 120,000 characters; the worker limit is 100,000.'
      )
    })
    let chain = chainOf(['one', 'two'])
    const refused: SessionOutcomeAttempt[] = []

    await launchSessionOutcomeWork(
      {
        runtime: {} as never,
        read: () => chain,
        save: (next) => {
          chain = next
        },
        persistAttempt: (attempt) => {
          refused.push(attempt)
        }
      },
      { limit: 2, parallel: new Set(['one', 'two']), inFlight: [] }
    )

    // The refusal is a not-started attempt with a code, so the recovery ladder decides what it
    // needs — here a shorter stage, asked of the person — instead of an unclassified block.
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({
      outcomeId: 'one',
      actionId: 'write_one',
      state: 'blocked',
      launchDisposition: 'not-started',
      failure: { code: 'brief-too-large' }
    })
    expect(chain.outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      block: { class: 'recovering', code: 'brief-too-large' }
    })
    expect(mocks.launch.mock.calls.map((call) => call[2])).toEqual(['two'])
  })
})
