import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { WorkflowModelPresetsPersistence } from './workflow-model-presets-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'
import { DEFAULT_WORKFLOW_MODEL_TIERS } from '../../../shared/workflow-model-tiers'
vi.mock('./write-scheduling', () => ({ scheduleSave: vi.fn() }))
describe('workflow model preset persistence', () => {
  it('survives restart, isolates returned values and deletes only the requested preset', () => {
    const state = {} as PersistedState
    const store = new WorkflowModelPresetsPersistence({ state }, {} as WriteSchedulingOperations)
    const saved = store.saveWorkflowModelPreset({
      name: ' Cheap ',
      models: [{ route: 'openrouter', model: 'deepseek/chat' }]
    })
    expect(saved[0].name).toBe('Cheap')
    saved[0].name = 'mutated'
    expect(store.listWorkflowModelPresets()[0].name).toBe('Cheap')
    const restarted = new WorkflowModelPresetsPersistence(
      { state: JSON.parse(JSON.stringify(state)) },
      {} as WriteSchedulingOperations
    )
    expect(restarted.listWorkflowModelPresets()).toEqual(store.listWorkflowModelPresets())
    expect(restarted.deleteWorkflowModelPreset(saved[0].id)).toEqual([])
  })
  it('refuses missing OpenRouter models and empty names', () => {
    const store = new WorkflowModelPresetsPersistence(
      { state: {} as PersistedState },
      {} as WriteSchedulingOperations
    )
    expect(() =>
      store.saveWorkflowModelPreset({ name: 'x', models: [{ route: 'openrouter' }] })
    ).toThrow()
    expect(() =>
      store.saveWorkflowModelPreset({ name: ' ', models: [{ route: 'claude' }] })
    ).toThrow()
  })
  it('keeps the built-in tiers until a person changes them, and goes back on reset', () => {
    const state = {} as PersistedState
    const store = new WorkflowModelPresetsPersistence({ state }, {} as WriteSchedulingOperations)
    expect(store.readWorkflowModelTiers()).toEqual({
      tiers: DEFAULT_WORKFLOW_MODEL_TIERS,
      customized: false
    })
    const cheap = [
      { route: 'openrouter' as const, model: 'qwen/qwen3.8-27b:free' },
      { route: 'ollama' as const, model: 'qwen3:8b' }
    ]
    const saved = store.saveWorkflowModelTiers({ ...DEFAULT_WORKFLOW_MODEL_TIERS, cheap })
    expect(saved).toMatchObject({ customized: true, tiers: { cheap } })
    const restarted = new WorkflowModelPresetsPersistence(
      { state: JSON.parse(JSON.stringify(state)) },
      {} as WriteSchedulingOperations
    )
    expect(restarted.readWorkflowModelTiers().tiers.cheap).toEqual(cheap)
    expect(() =>
      store.saveWorkflowModelTiers({ ...DEFAULT_WORKFLOW_MODEL_TIERS, cheap: [] })
    ).toThrow()
    expect(() =>
      store.saveWorkflowModelTiers({
        ...DEFAULT_WORKFLOW_MODEL_TIERS,
        cheap: [{ route: 'ollama', model: 'not a tag' }]
      })
    ).toThrow()
    expect(store.saveWorkflowModelTiers(null)).toEqual({
      tiers: DEFAULT_WORKFLOW_MODEL_TIERS,
      customized: false
    })
    expect(state.workflowModelTiers).toBeUndefined()
  })
})
