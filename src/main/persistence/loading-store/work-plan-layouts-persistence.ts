import { randomUUID } from 'node:crypto'
import {
  normalizeWorkPlanLayoutName,
  normalizeWorkPlanLayouts,
  WorkPlanLayoutStageSchema,
  WORK_PLAN_LAYOUTS_MAX,
  type WorkPlanLayout
} from '../../../shared/work-plan-layouts'
import type { UpNextAgentDraft } from '../../../shared/up-next-types'
import type { StoreRuntimeState } from './store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'

const workPlanLayoutsContext = Symbol('WorkPlanLayoutsPersistence')
type LayoutsContext = {
  runtime: Pick<StoreRuntimeState, 'state'>
  scheduling: WriteSchedulingOperations
}

export class WorkPlanLayoutsPersistence {
  readonly [workPlanLayoutsContext]: LayoutsContext

  constructor(runtime: Pick<StoreRuntimeState, 'state'>, scheduling: WriteSchedulingOperations) {
    this[workPlanLayoutsContext] = { runtime, scheduling }
  }

  listWorkPlanLayouts(): WorkPlanLayout[] {
    return structuredClone(
      normalizeWorkPlanLayouts(this[workPlanLayoutsContext].runtime.state.workPlanLayouts)
    )
  }

  saveWorkPlanLayout(input: { name: string; stage: UpNextAgentDraft }): WorkPlanLayout[] {
    const layouts = this.listWorkPlanLayouts()
    if (layouts.length >= WORK_PLAN_LAYOUTS_MAX) {
      throw new Error('The saved workflow limit has been reached.')
    }
    const now = Date.now()
    return this.writeWorkPlanLayouts([
      ...layouts,
      {
        id: randomUUID(),
        name: normalizeWorkPlanLayoutName(input.name),
        createdAt: now,
        updatedAt: now,
        stage: WorkPlanLayoutStageSchema.parse(input.stage)
      }
    ])
  }

  renameWorkPlanLayout(id: string, name: string): WorkPlanLayout[] {
    const normalized = normalizeWorkPlanLayoutName(name)
    const layouts = this.listWorkPlanLayouts()
    if (!layouts.some((entry) => entry.id === id)) {
      throw new Error('Saved workflow not found.')
    }
    return this.writeWorkPlanLayouts(
      layouts.map((entry) =>
        entry.id === id
          ? { ...entry, name: normalized, updatedAt: Math.max(Date.now(), entry.updatedAt) }
          : entry
      )
    )
  }

  deleteWorkPlanLayout(id: string): WorkPlanLayout[] {
    return this.writeWorkPlanLayouts(this.listWorkPlanLayouts().filter((entry) => entry.id !== id))
  }

  private writeWorkPlanLayouts(layouts: WorkPlanLayout[]): WorkPlanLayout[] {
    const { runtime, scheduling } = this[workPlanLayoutsContext]
    runtime.state.workPlanLayouts = layouts
    scheduleSave(scheduling)
    return this.listWorkPlanLayouts()
  }
}

export function installWorkPlanLayoutsPersistenceContext(
  target: object,
  source: WorkPlanLayoutsPersistence
): void {
  Object.defineProperty(target, workPlanLayoutsContext, { value: source[workPlanLayoutsContext] })
}
