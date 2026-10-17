/**
 * What the commit door accepts over the wire.
 *
 * `sessionChain.commitOutcomes` validates `.strict()`, so a field the engine reads and the
 * schema does not name can only ever be sent in process: the CLI, the renderer and a paired
 * device were refused outright. Two such fields were left behind by the Wave-3 engine work —
 * the withdrawal of a queued finish (`clearSessionFinish`), and what a superseding plan still
 * draws (`drawsSteps`) — and each is a decision only the person's own surface makes.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_CHAIN_METHODS } from './session-chains'

const commit = SESSION_CHAIN_METHODS.find(
  (method) => method.name === 'sessionChain.commitOutcomes'
)!

const params = (over: Record<string, unknown>): unknown =>
  commit.params!.parse({
    chain: { id: 'chain' },
    expectedRevision: 1,
    source: 'user',
    outcomes: [
      {
        id: 'ship',
        title: 'Ship it',
        finish: 'complete',
        dependsOn: [],
        actions: [],
        conditions: [{ id: 'c1', kind: 'review', target: 'me' }]
      }
    ],
    ...over
  })

describe('sessionChain.commitOutcomes', () => {
  it('accepts the withdrawal of a queued finish', () => {
    expect(params({ clearSessionFinish: true })).toMatchObject({ clearSessionFinish: true })
  })

  it('accepts only the withdrawal itself, never a "keep it" flag', () => {
    // `false` would read as "leave the finish alone", which is what LEAVING IT OUT already means.
    expect(() => params({ clearSessionFinish: false })).toThrow()
  })

  it('accepts the steps a superseding plan still draws', () => {
    expect(
      params({ supersede: { reason: 'Removed a queued stage.' }, drawsSteps: ['seat-a'] })
    ).toMatchObject({ drawsSteps: ['seat-a'] })
  })

  it('still refuses a field it does not name', () => {
    expect(() => params({ retireEverything: true })).toThrow()
  })
})
