import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { SessionChainPersistence } from './session-chain-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

vi.mock('./write-scheduling', () => ({ scheduleSave: vi.fn() }))

const chain = (id: string) => ({
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
})

describe('SessionChainPersistence', () => {
  it('lists, updates and removes persisted chains in the profile state and schedules a save', async () => {
    const { scheduleSave } = await import('./write-scheduling')
    const state = { sessionChains: undefined } as unknown as PersistedState
    const scheduling = {} as WriteSchedulingOperations
    const persistence = new SessionChainPersistence({ state }, scheduling)

    expect(persistence.listSessionChains()).toEqual([])
    state.sessionChains = [chain('chn_1')] as PersistedState['sessionChains']
    const stored = persistence.upsertSessionChain(chain('chn_1'))
    expect(stored.id).toBe('chn_1')
    expect(stored.updatedAt).toBeGreaterThanOrEqual(10)
    expect(persistence.listSessionChains().map((entry) => entry.id)).toEqual(['chn_1'])

    persistence.upsertSessionChain({ ...chain('chn_1'), state: 'done', currentIndex: 1 })
    expect(persistence.listSessionChains()).toHaveLength(1)
    expect(persistence.listSessionChains()[0]).toMatchObject({ state: 'done', currentIndex: 1 })

    expect(persistence.removeSessionChain('chn_1')).toBe(true)
    expect(persistence.removeSessionChain('chn_1')).toBe(false)
    expect(persistence.listSessionChains()).toEqual([])
    expect(scheduleSave).toHaveBeenCalledTimes(3)
  })

  it('refuses a chain without steps or identity', () => {
    const state = { sessionChains: [] } as unknown as PersistedState
    const persistence = new SessionChainPersistence({ state }, {} as WriteSchedulingOperations)
    expect(() => persistence.upsertSessionChain({ ...chain('chn_2'), steps: [] })).toThrow(
      'at least one step'
    )
    expect(() => persistence.upsertSessionChain({ id: 'chn_3' })).toThrow()
    expect(state.sessionChains).toEqual([])
  })

  it('keeps a plan that only ends its session, and never turns unreadable steps into one', () => {
    const state = { sessionChains: [] } as unknown as PersistedState
    const persistence = new SessionChainPersistence({ state }, {} as WriteSchedulingOperations)
    state.sessionChains = [
      { ...chain('chn_4'), steps: [], end: 'done' }
    ] as PersistedState['sessionChains']
    const stored = persistence.upsertSessionChain({ ...chain('chn_4'), steps: [], end: 'done' })
    expect(stored).toMatchObject({ id: 'chn_4', steps: [], end: 'done', currentIndex: 0 })
    expect(() =>
      persistence.upsertSessionChain({ ...chain('chn_5'), steps: [], end: 'me' })
    ).toThrow('at least one step')
    expect(() =>
      persistence.upsertSessionChain({
        ...chain('chn_6'),
        steps: [{ kind: 'from-a-newer-build', id: 's1' }],
        end: 'done'
      })
    ).toThrow('at least one step')
    expect(persistence.listSessionChains().map((entry) => entry.id)).toEqual(['chn_4'])
  })
})
