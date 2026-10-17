import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SessionChain } from '../../../shared/session-chain-types'
import { runSet } from '../../../shared/session-run-lifecycle.test-fixture'
import { SessionChainPersistence } from './session-chain-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

vi.mock('./write-scheduling', () => ({ scheduleSave: vi.fn() }))

const chain = (id: string) =>
  ({
    id,
    workspacePath: '/Users/me/Webinar',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: '["local","folder:f1","tab-1:leaf-1"]',
    auto: false,
    steps: [{ id: 's1', agent: 'claude', prompt: 'improve the intro', status: 'queued' }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 10,
    updatedAt: 10
  }) as unknown as SessionChain

function fixture(chains: SessionChain[] | undefined = [chain('chn_1'), chain('chn_2')]) {
  const state = { sessionChains: chains } as PersistedState
  const persistence = new SessionChainPersistence(
    { state, flushOrThrow: vi.fn(), writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  return { state, persistence }
}

describe('SessionChainPersistence read snapshot', () => {
  it('returns the same frozen snapshot while nothing is written', () => {
    const { persistence } = fixture()
    const first = persistence.listSessionChains()
    expect(persistence.listSessionChains()).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0])).toBe(true)
    expect(Object.isFrozen(first[0]!.steps)).toBe(true)
    expect(Object.isFrozen(first[0]!.steps[0])).toBe(true)
  })

  it('reads an absent list as one stable empty snapshot', () => {
    const { state, persistence } = fixture()
    // Why explicit: passing undefined to fixture() would take its default list.
    state.sessionChains = undefined
    const first = persistence.listSessionChains()
    expect(first).toEqual([])
    expect(persistence.listSessionChains()).toBe(first)
  })

  it('refreshes after an upsert', () => {
    const { persistence } = fixture()
    const before = persistence.listSessionChains()
    persistence.upsertSessionChain({ ...chain('chn_1'), state: 'done', currentIndex: 1 })
    const after = persistence.listSessionChains()
    expect(after).not.toBe(before)
    expect(after[0]).toMatchObject({ id: 'chn_1', state: 'done', currentIndex: 1 })
    expect(before[0]).toMatchObject({ state: 'waiting', currentIndex: 0 })
    expect(persistence.listSessionChains()).toBe(after)
  })

  it('refreshes after a remove and after the whole list is replaced', () => {
    const { state, persistence } = fixture()
    const before = persistence.listSessionChains()
    expect(persistence.removeSessionChain('chn_2')).toBe(true)
    expect(persistence.listSessionChains().map((entry) => entry.id)).toEqual(['chn_1'])
    state.sessionChains = [chain('chn_3')]
    expect(persistence.listSessionChains().map((entry) => entry.id)).toEqual(['chn_3'])
    expect(before.map((entry) => entry.id)).toEqual(['chn_1', 'chn_2'])
  })

  it('refreshes after a committed outcome write, and keeps the snapshot when the flush fails', () => {
    const { state, persistence } = fixture()
    let failFlush = false
    const writer = new SessionChainPersistence(
      {
        state,
        flushOrThrow: () => {
          if (failFlush) {
            throw new Error('disk full')
          }
        },
        writesFrozen: false
      },
      {} as WriteSchedulingOperations
    )
    const before = persistence.listSessionChains()
    const planned = { ...chain('chn_9'), steps: [], auto: true, outcomeSet: runSet() }
    const saved = writer.replaceSessionChainOutcomesAndFlush(planned, 0)
    const after = persistence.listSessionChains()
    expect(after).not.toBe(before)
    expect(after.map((entry) => entry.id)).toEqual(['chn_1', 'chn_2', 'chn_9'])
    expect(Object.isFrozen(saved)).toBe(false)

    failFlush = true
    const stored = state.sessionChains
    expect(() =>
      writer.replaceSessionChainOutcomesAndFlush(
        { ...chain('chn_10'), steps: [], auto: true, outcomeSet: runSet() },
        0
      )
    ).toThrow('disk full')
    expect(state.sessionChains).toBe(stored)
    expect(persistence.listSessionChains()).toBe(after)
  })

  it('refuses changes to the snapshot and keeps the stored chains untouched', () => {
    const { state, persistence } = fixture()
    const snapshot = persistence.listSessionChains()
    expect(() => snapshot.push(chain('chn_x'))).toThrow(TypeError)
    expect(() => snapshot.sort((a, b) => b.id.localeCompare(a.id))).toThrow(TypeError)
    expect(() => {
      snapshot[0]!.state = 'done'
    }).toThrow(TypeError)
    expect(() => {
      snapshot[0]!.steps[0]!.status = 'launched'
    }).toThrow(TypeError)
    expect(snapshot[0]).not.toBe(state.sessionChains![0])
    expect(state.sessionChains!.map((entry) => entry.id)).toEqual(['chn_1', 'chn_2'])
    expect(state.sessionChains![0]).toMatchObject({ state: 'waiting' })
    expect(Object.isFrozen(state.sessionChains![0])).toBe(false)
    expect(persistence.listSessionChains()).toBe(snapshot)
  })
})
