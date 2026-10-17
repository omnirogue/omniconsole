import { describe, expect, it } from 'vitest'
import { sessionOutcomeDependencies } from './session-outcome-dependencies'
import type { SessionOutcomeSet } from './session-outcome-types'

type Row = {
  id: string
  title: string
  status: string
  dependsOn: string[]
  blockedReason?: string
}
function set(outcomes: Row[], removed: string[] = []) {
  return {
    outcomes,
    removals: removed.map((outcomeId) => ({
      outcomeId,
      revision: 1,
      reason: 'dropped',
      removedAt: 0
    }))
  } as unknown as Pick<SessionOutcomeSet, 'outcomes' | 'removals'>
}

describe('session outcome dependencies', () => {
  it('returns nothing without an outcome set', () => {
    expect(sessionOutcomeDependencies(null)).toEqual([])
  })

  it('reads a partial set that carries no removals or dependsOn', () => {
    const partial = {
      outcomes: [
        { id: 'a', title: 'A', status: 'pending', dependsOn: ['b'] },
        { id: 'b', title: 'B', status: 'running' }
      ]
    } as unknown as Pick<SessionOutcomeSet, 'outcomes' | 'removals'>
    const views = sessionOutcomeDependencies(partial)
    expect(views[0]).toMatchObject({ state: 'waiting', waitingOn: ['B'] })
    expect(views[1]).toMatchObject({ state: 'free' })
  })

  it('separates free, ready and waiting outcomes', () => {
    const views = sessionOutcomeDependencies(
      set([
        { id: 'build', title: 'Build', status: 'satisfied', dependsOn: [] },
        { id: 'test', title: 'Test', status: 'running', dependsOn: ['build'] },
        { id: 'ship', title: 'Ship', status: 'pending', dependsOn: ['build', 'test'] }
      ])
    )
    expect(views).toEqual([
      { outcomeId: 'build', title: 'Build', state: 'free' },
      { outcomeId: 'test', title: 'Test', state: 'ready' },
      { outcomeId: 'ship', title: 'Ship', state: 'waiting', waitingOn: ['Test'] }
    ])
  })

  it('names a failed prerequisite, including one further up the chain', () => {
    const views = sessionOutcomeDependencies(
      set([
        { id: 'build', title: 'Build', status: 'blocked', dependsOn: [], blockedReason: 'exit 1' },
        { id: 'test', title: 'Test', status: 'pending', dependsOn: ['build'] },
        { id: 'ship', title: 'Ship', status: 'pending', dependsOn: ['test'] }
      ])
    )
    const blocker = { outcomeId: 'build', title: 'Build', cause: 'failed', detail: 'exit 1' }
    expect(views[1]).toEqual({
      outcomeId: 'test',
      title: 'Test',
      state: 'blocked',
      blockedBy: [blocker]
    })
    expect(views[2]).toEqual({
      outcomeId: 'ship',
      title: 'Ship',
      state: 'blocked',
      blockedBy: [blocker]
    })
  })

  it('treats a removed prerequisite as abandoned and survives a cycle', () => {
    const views = sessionOutcomeDependencies(
      set(
        [
          { id: 'a', title: 'A', status: 'pending', dependsOn: ['gone'] },
          { id: 'b', title: 'B', status: 'pending', dependsOn: ['c'] },
          { id: 'c', title: 'C', status: 'pending', dependsOn: ['b'] }
        ],
        ['gone']
      )
    )
    expect(views[0]).toMatchObject({ state: 'blocked', blockedBy: [{ cause: 'abandoned' }] })
    expect(views[1]).toEqual({ outcomeId: 'b', title: 'B', state: 'waiting', waitingOn: ['C'] })
  })

  it('never calls an outcome ready when a prerequisite is absent from the plan', () => {
    const views = sessionOutcomeDependencies(
      set([
        { id: 'build', title: 'Build', status: 'satisfied', dependsOn: [] },
        { id: 'ship', title: 'Ship', status: 'pending', dependsOn: ['build', 'lost'] }
      ])
    )
    expect(views[1]).toEqual({
      outcomeId: 'ship',
      title: 'Ship',
      state: 'blocked',
      blockedBy: [{ outcomeId: 'lost', title: 'lost', cause: 'missing', detail: null }]
    })
  })
})
