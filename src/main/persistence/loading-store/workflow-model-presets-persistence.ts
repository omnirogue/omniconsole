import { randomUUID } from 'node:crypto'
import {
  normalizeWorkflowModelPresets,
  WorkflowModelPresetInputSchema,
  type WorkflowModelPreset,
  type WorkflowModelPresetInput
} from '../../../shared/workflow-model-presets'
import {
  normalizeWorkflowModelTiers,
  WorkflowModelTiersSchema,
  type WorkflowModelTiers
} from '../../../shared/workflow-model-tiers'
import type { StoreRuntimeState } from './store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'
const presetContext = Symbol('WorkflowModelPresetsPersistence')
export class WorkflowModelPresetsPersistence {
  readonly [presetContext]: {
    runtime: Pick<StoreRuntimeState, 'state'>
    scheduling: WriteSchedulingOperations
  }
  constructor(runtime: Pick<StoreRuntimeState, 'state'>, scheduling: WriteSchedulingOperations) {
    this[presetContext] = { runtime, scheduling }
  }
  listWorkflowModelPresets(): WorkflowModelPreset[] {
    return structuredClone(
      normalizeWorkflowModelPresets(this[presetContext].runtime.state.workflowModelPresets)
    )
  }
  saveWorkflowModelPreset(input: WorkflowModelPresetInput): WorkflowModelPreset[] {
    const presets = this.listWorkflowModelPresets()
    if (presets.length >= 50) {
      throw new Error('The model preset limit has been reached.')
    }
    return this.writeWorkflowModelPresets([
      ...presets,
      { ...WorkflowModelPresetInputSchema.parse(input), id: randomUUID() }
    ])
  }
  deleteWorkflowModelPreset(id: string): WorkflowModelPreset[] {
    return this.writeWorkflowModelPresets(
      this.listWorkflowModelPresets().filter((preset) => preset.id !== id)
    )
  }
  /** The lineups in use, and whether they are the person's own or the built-in ones. */
  readWorkflowModelTiers(): { tiers: WorkflowModelTiers; customized: boolean } {
    const saved = this[presetContext].runtime.state.workflowModelTiers
    return { tiers: normalizeWorkflowModelTiers(saved), customized: !!saved }
  }
  /** `null` goes back to the built-in lineups. */
  saveWorkflowModelTiers(tiers: WorkflowModelTiers | null): {
    tiers: WorkflowModelTiers
    customized: boolean
  } {
    const { runtime, scheduling } = this[presetContext]
    if (tiers) {
      runtime.state.workflowModelTiers = WorkflowModelTiersSchema.parse(tiers)
    } else {
      delete runtime.state.workflowModelTiers
    }
    scheduleSave(scheduling)
    return this.readWorkflowModelTiers()
  }
  private writeWorkflowModelPresets(presets: WorkflowModelPreset[]): WorkflowModelPreset[] {
    const { runtime, scheduling } = this[presetContext]
    runtime.state.workflowModelPresets = presets
    scheduleSave(scheduling)
    return this.listWorkflowModelPresets()
  }
}
export function installWorkflowModelPresetsPersistenceContext(
  target: object,
  source: WorkflowModelPresetsPersistence
): void {
  Object.defineProperty(target, presetContext, { value: source[presetContext] })
}
