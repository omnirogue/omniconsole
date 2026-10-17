import { z } from 'zod'
import { consoleWorkflowLoopStopRule } from './console-workflow-loop'
import { SESSION_ACTION_PRESET_IDS } from './session-action-presets'
import {
  UP_NEXT_MAX_BLOCKS,
  UP_NEXT_MAX_SEATS_PER_STAGE,
  type UpNextAgentDraft
} from './up-next-types'
import { WORK_PLAN_MAX_REVIEW_ROUNDS } from './work-plan-types'

export type WorkPlanLayout = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  stage: UpNextAgentDraft
}

export const WORK_PLAN_LAYOUTS_MAX = 25
export const WORK_PLAN_LAYOUT_NAME_MAX = 100
export const WORK_PLAN_LAYOUTS_RPC = {
  list: 'workPlanLayouts.list',
  save: 'workPlanLayouts.save',
  rename: 'workPlanLayouts.rename',
  delete: 'workPlanLayouts.delete'
} as const

export function normalizeWorkPlanLayoutName(name: string): string {
  const normalized = name.trim().slice(0, WORK_PLAN_LAYOUT_NAME_MAX)
  if (!normalized) {
    throw new Error('A saved workflow needs a name.')
  }
  return normalized
}

// Match the authorable Up next stage contract; never persist block execution facts.
export const WorkPlanLayoutStageSchema = z
  .object({
    kind: z.literal('agent'),
    template: z.enum([...SESSION_ACTION_PRESET_IDS, 'custom']),
    shape: z.enum(['solo', 'parallel', 'council', 'best-of', 'custom']).optional(),
    n: z.number().int().min(1).max(UP_NEXT_MAX_SEATS_PER_STAGE).optional(),
    instruction: z.string().max(32_000).optional(),
    advanced: z
      .object({
        model: z.string().min(1).max(200).optional(),
        effort: z.string().min(1).max(64).optional(),
        rounds: z.number().int().min(1).max(WORK_PLAN_MAX_REVIEW_ROUNDS).optional(),
        stopWhen: consoleWorkflowLoopStopRule.optional(),
        readsFrom: z.array(z.string().trim().min(1).max(256)).max(UP_NEXT_MAX_BLOCKS).optional(),
        endOnSuccess: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()

export function normalizeWorkPlanLayout(raw: unknown): WorkPlanLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const id = typeof value.id === 'string' ? value.id.trim().slice(0, 200) : ''
  if (!id || typeof value.name !== 'string' || !value.name.trim()) {
    return null
  }
  const { createdAt, updatedAt } = value
  if (
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    createdAt < 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < createdAt
  ) {
    return null
  }
  const stage = WorkPlanLayoutStageSchema.safeParse(value.stage)
  if (!stage.success) {
    return null
  }
  return {
    id,
    name: normalizeWorkPlanLayoutName(value.name),
    createdAt,
    updatedAt,
    stage: stage.data
  }
}

export function capWorkPlanLayouts(layouts: readonly WorkPlanLayout[]): WorkPlanLayout[] {
  return layouts.slice(-WORK_PLAN_LAYOUTS_MAX)
}

export function normalizeWorkPlanLayouts(raw: unknown): WorkPlanLayout[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const entries = raw
    .map(normalizeWorkPlanLayout)
    .filter((entry): entry is WorkPlanLayout => entry !== null)
  return capWorkPlanLayouts([...new Map(entries.map((entry) => [entry.id, entry])).values()])
}
