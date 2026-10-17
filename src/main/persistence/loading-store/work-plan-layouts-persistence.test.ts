import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeWorkPlanLayouts, WORK_PLAN_LAYOUTS_MAX } from '../../../shared/work-plan-layouts'
import { WorkPlanLayoutsPersistence } from './work-plan-layouts-persistence'
import { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'

vi.mock('./write-scheduling', () => ({ scheduleSave: vi.fn() }))
const stage = {
  kind: 'agent' as const,
  template: 'improve' as const,
  shape: 'parallel' as const,
  n: 3,
  advanced: { model: 'model', rounds: 2, readsFrom: [], endOnSuccess: false }
}
function store(state = {} as PersistedState) {
  return {
    state,
    persistence: new WorkPlanLayoutsPersistence({ state }, {} as WriteSchedulingOperations)
  }
}

describe('profile saved layouts', () => {
  it('survives profile serialization and a fresh persistence instance', () => {
    const { state, persistence } = store()
    const saved = persistence.saveWorkPlanLayout({ name: ' Review ', stage })
    const serializer = new StateSerializationSecretHandlingOperations({
      state,
      protectedSecrets: new ProtectedSecretPersistence()
    })
    const parsed = JSON.parse(JSON.stringify(serializer.getDurableState())) as PersistedState
    parsed.workPlanLayouts = normalizeWorkPlanLayouts(parsed.workPlanLayouts)
    const restarted = store(parsed).persistence
    expect(restarted.listWorkPlanLayouts()).toEqual(saved)
    expect(saved[0]?.name).toBe('Review')
    restarted.renameWorkPlanLayout(saved[0]!.id, 'Renamed')
    expect(restarted.listWorkPlanLayouts()[0]?.name).toBe('Renamed')
    expect(restarted.deleteWorkPlanLayout(saved[0]!.id)).toEqual([])
    expect(scheduleSave).toHaveBeenCalled()
  })

  it('isolates input and returned objects from profile state', () => {
    const { persistence } = store()
    const input = structuredClone(stage)
    const saved = persistence.saveWorkPlanLayout({ name: 'Stage', stage: input })
    input.advanced.model = 'changed'
    saved[0]!.stage.advanced!.model = 'also changed'
    expect(persistence.listWorkPlanLayouts()[0]?.stage).toEqual(stage)
  })

  it('rejects invalid writes and refuses overflow without losing saved layouts', () => {
    const { persistence } = store()
    expect(() => persistence.saveWorkPlanLayout({ name: ' ', stage })).toThrow()
    for (let n = 0; n < WORK_PLAN_LAYOUTS_MAX; n++) {
      persistence.saveWorkPlanLayout({ name: String(n), stage })
    }
    expect(() => persistence.saveWorkPlanLayout({ name: 'overflow', stage })).toThrow()
    expect(persistence.listWorkPlanLayouts()).toHaveLength(WORK_PLAN_LAYOUTS_MAX)
    expect(() => persistence.renameWorkPlanLayout('missing', 'Name')).toThrow()
  })

  it('drops corrupt records independently on restart', () => {
    const { persistence } = store()
    const [layout] = persistence.saveWorkPlanLayout({ name: 'Stage', stage })
    expect(
      normalizeWorkPlanLayouts([
        null,
        layout,
        { ...layout, stage: { kind: 'done' } },
        { ...layout, createdAt: -1 }
      ])
    ).toEqual([layout])
  })
})
