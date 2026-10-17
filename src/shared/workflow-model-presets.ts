import { z } from 'zod'
import { isOllamaModelTag } from './local-ollama-launch'
import { openrouterApiId } from './openrouter-route'
import { workflowKindJudges, workflowRouteMayJudge, type WorkflowSpec } from './workflow-graph'

export const WorkflowPresetModelSchema = z
  .object({
    route: z.enum(['claude', 'codex', 'grok', 'gemini', 'openrouter', 'ollama']),
    model: z.string().min(1).max(512).optional()
  })
  .strict()
  .refine((value) => value.route !== 'openrouter' || openrouterApiId.safeParse(value.model).success)
  .refine((value) => value.route !== 'ollama' || isOllamaModelTag(value.model))
export const WorkflowModelPresetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    models: z.array(WorkflowPresetModelSchema).min(1).max(64)
  })
  .strict()
export const WorkflowModelPresetSchema = WorkflowModelPresetInputSchema.extend({
  id: z.string().uuid()
})
export type WorkflowPresetModel = z.infer<typeof WorkflowPresetModelSchema>
export type WorkflowModelPreset = z.infer<typeof WorkflowModelPresetSchema>
export type WorkflowModelPresetInput = z.infer<typeof WorkflowModelPresetInputSchema>

export function normalizeWorkflowModelPresets(raw: unknown): WorkflowModelPreset[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .flatMap((entry) => {
      const parsed = WorkflowModelPresetSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    .slice(0, 50)
}

export function workflowCurrentModels(spec: WorkflowSpec): WorkflowPresetModel[] {
  const models = spec.steps.flatMap((step) =>
    step.agents.map(({ route, model }) => ({ route, ...(model ? { model } : {}) }))
  )
  return [...new Map(models.map((model) => [JSON.stringify(model), model])).values()]
}

export function applyWorkflowModelPreset(
  spec: WorkflowSpec,
  models: readonly WorkflowPresetModel[]
): { spec: WorkflowSpec; unchanged: string[] } {
  let cursor = 0
  const unchanged: string[] = []
  return {
    unchanged,
    spec: {
      ...spec,
      steps: spec.steps.map((step) => {
        const eligible = models.filter(
          (model) =>
            !workflowKindJudges(step.kind) || workflowRouteMayJudge(model.route, model.model)
        )
        if (!eligible.length) {
          unchanged.push(step.id)
          return step
        }
        return {
          ...step,
          agents: step.agents.map((agent) => {
            const chosen = eligible[cursor++ % eligible.length]
            return { ...agent, route: chosen.route, model: chosen.model }
          })
        }
      })
    }
  }
}
