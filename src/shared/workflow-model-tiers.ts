import { z } from 'zod'
import { modelLineage } from './model-lineage'
import {
  WORKFLOW_MAX_AGENTS_PER_STEP,
  workflowKindJudges,
  workflowRouteMayJudge,
  type WorkflowAgentSpec,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepKind
} from './workflow-graph'
import { WorkflowPresetModelSchema, type WorkflowPresetModel } from './workflow-model-presets'

/**
 * Three named lineups a person picks from instead of naming models: Cheap, Standard, Frontier.
 * A lineup is an ordered list of models; its first model is the one a single-agent step gets, and
 * a step with more agents takes the next ones in order, so families stay mixed. A step's tier is
 * never stored: it is read back from the models its agents run, so the workflow format, saved
 * tabs and older hosts are untouched.
 */
export const WORKFLOW_MODEL_TIERS = ['cheap', 'standard', 'frontier'] as const
export type WorkflowModelTier = (typeof WORKFLOW_MODEL_TIERS)[number]
export type WorkflowModelTiers = Record<WorkflowModelTier, WorkflowPresetModel[]>
/** Each family's default model id, so an agent that names none compares as that model. */
export type WorkflowModelDefaults = Partial<Record<WorkflowRoute, string>>

export const WORKFLOW_TIER_MAX_MODELS = 16
const STRONGEST_FIRST: readonly WorkflowModelTier[] = ['frontier', 'standard', 'cheap']

const Lineup = z.array(WorkflowPresetModelSchema).min(1).max(WORKFLOW_TIER_MAX_MODELS)
export const WorkflowModelTiersSchema = z
  .object({ cheap: Lineup, standard: Lineup, frontier: Lineup })
  .strict()

/**
 * The lineups before a person changes them: the models every signed-in family runs for
 * workflows (local-workflow-models.ts). OpenRouter and Ollama models are added by the person,
 * because which ones exist changes by the week and by the computer.
 */
export const DEFAULT_WORKFLOW_MODEL_TIERS: WorkflowModelTiers = {
  cheap: [
    { route: 'claude', model: 'claude-haiku-5-5' },
    { route: 'codex', model: 'gpt-6-luna' },
    { route: 'gemini', model: 'gemini-3.8-flash' }
  ],
  standard: [
    { route: 'claude', model: 'sonnet' },
    { route: 'codex', model: 'gpt-5.6-sol' },
    { route: 'grok', model: 'grok-4.6' }
  ],
  frontier: [
    { route: 'gemini', model: 'gemini-4-argon' },
    { route: 'claude', model: 'opus' },
    { route: 'codex', model: 'gpt-6-astra' },
    { route: 'grok', model: 'grok-4.6' }
  ]
}

export function isWorkflowModelTier(value: unknown): value is WorkflowModelTier {
  return (WORKFLOW_MODEL_TIERS as readonly unknown[]).includes(value)
}

/** Saved lineups, tier by tier: one that does not parse falls back to its default. */
export function normalizeWorkflowModelTiers(raw: unknown): WorkflowModelTiers {
  const saved = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const tiers = structuredClone(DEFAULT_WORKFLOW_MODEL_TIERS)
  for (const tier of WORKFLOW_MODEL_TIERS) {
    const parsed = Lineup.safeParse(saved[tier])
    if (parsed.success) {
      tiers[tier] = parsed.data
    }
  }
  return tiers
}

function modelId(model: WorkflowPresetModel, defaults: WorkflowModelDefaults): string {
  return model.model ?? defaults[model.route] ?? ''
}

export function sameWorkflowModel(
  left: WorkflowPresetModel,
  right: WorkflowPresetModel,
  defaults: WorkflowModelDefaults = {}
): boolean {
  return left.route === right.route && modelId(left, defaults) === modelId(right, defaults)
}

/** A lineup as one step may use it: families this computer runs, and only judges where it judges. */
export function workflowTierLineup(
  lineup: readonly WorkflowPresetModel[],
  kind: WorkflowStepKind,
  available: readonly WorkflowRoute[]
): WorkflowPresetModel[] {
  return lineup.filter(
    (model) =>
      available.includes(model.route) &&
      (!workflowKindJudges(kind) || workflowRouteMayJudge(model.route, model.model))
  )
}

/**
 * The lineup one step takes its models from. A review or rank step leads with the families that
 * did not write what it judges (the maker never judges its own work, as the templates arrange),
 * so a one-agent judge on the same tier as the work still comes from another family when the
 * lineup has one. A synthesizer combines rather than judges, and keeps the lineup's own order.
 */
export function workflowStepTierLineup(
  spec: Pick<WorkflowSpec, 'steps'>,
  step: Pick<WorkflowStep, 'kind' | 'inputs'>,
  lineup: readonly WorkflowPresetModel[],
  available: readonly WorkflowRoute[]
): WorkflowPresetModel[] {
  const eligible = workflowTierLineup(lineup, step.kind, available)
  if (step.kind !== 'review' && step.kind !== 'rank') {
    return eligible
  }
  const authors = new Set(
    step.inputs.flatMap(
      (id) =>
        spec.steps
          .find((entry) => entry.id === id)
          ?.agents.map((agent) => modelLineage(agent.route, agent.model)) ?? []
    )
  )
  const wrote = (model: WorkflowPresetModel) => authors.has(modelLineage(model.route, model.model))
  return [...eligible.filter((model) => !wrote(model)), ...eligible.filter(wrote)]
}

/** The agent with a lineup model; a family's default model stays unnamed, as the editor leaves it. */
function withModel(
  agent: WorkflowAgentSpec,
  chosen: WorkflowPresetModel,
  defaults: WorkflowModelDefaults
): WorkflowAgentSpec {
  const { model: _model, ...rest } = agent
  const named = chosen.model && chosen.model !== defaults[chosen.route] ? chosen.model : undefined
  return { ...rest, route: chosen.route, ...(named ? { model: named } : {}) }
}

/**
 * Puts a tier's lineup on one step, or on every step. Only models change: angles, system prompts
 * and how many agents a step has stay. A step the lineup has no eligible model for is left as it
 * was and named in `unchanged`.
 */
export function applyWorkflowModelTier(
  spec: WorkflowSpec,
  input: {
    tier: WorkflowModelTier
    tiers: WorkflowModelTiers
    available: readonly WorkflowRoute[]
    defaults?: WorkflowModelDefaults
    /** Only this step; absent means every step. */
    stepId?: string
  }
): { spec: WorkflowSpec; unchanged: string[] } {
  const unchanged: string[] = []
  const defaults = input.defaults ?? {}
  // In order, so a judge sees the models its input steps were just given.
  let next = spec
  for (const step of spec.steps) {
    if (input.stepId && step.id !== input.stepId) {
      continue
    }
    const lineup = workflowStepTierLineup(next, step, input.tiers[input.tier], input.available)
    if (!lineup.length) {
      unchanged.push(step.id)
      continue
    }
    next = {
      ...next,
      steps: next.steps.map((entry) =>
        entry.id === step.id
          ? {
              ...entry,
              agents: entry.agents.map((agent, index) =>
                withModel(agent, lineup[index % lineup.length], defaults)
              )
            }
          : entry
      )
    }
  }
  return { unchanged, spec: next }
}

/** One agent on a named model (or a family's default), everything else about it kept. */
export function withWorkflowAgentModel(
  spec: WorkflowSpec,
  stepId: string,
  agentIndex: number,
  chosen: WorkflowPresetModel,
  defaults: WorkflowModelDefaults = {}
): WorkflowSpec {
  return {
    ...spec,
    steps: spec.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            agents: step.agents.map((agent, index) =>
              index === agentIndex ? withModel(agent, chosen, defaults) : agent
            )
          }
        : step
    )
  }
}

/**
 * A combo: the step runs exactly these models, one agent each, so one step can mix providers
 * freely (Discover's finders on Claude, GPT, Grok, an OpenRouter model and a local one). Angles
 * and system prompts carry over in order and repeat when the combo has more models than the
 * step had agents. A Synthesize step keeps its one agent.
 */
export function withWorkflowStepModels(
  spec: WorkflowSpec,
  stepId: string,
  models: readonly WorkflowPresetModel[],
  defaults: WorkflowModelDefaults = {}
): WorkflowSpec {
  return {
    ...spec,
    steps: spec.steps.map((step) => {
      const chosen = models.slice(0, step.kind === 'synthesize' ? 1 : WORKFLOW_MAX_AGENTS_PER_STEP)
      if (step.id !== stepId || !chosen.length || !step.agents.length) {
        return step
      }
      return {
        ...step,
        agents: chosen.map((model, index) =>
          withModel(step.agents[index % step.agents.length], model, defaults)
        )
      }
    })
  }
}

/**
 * The tier a step is on: the one whose lineup holds every model its agents run. A model in two
 * lineups reads as the stronger tier; a step that mixes tiers, or runs a model in none, has no tier.
 */
export function workflowStepTier(
  step: Pick<WorkflowStep, 'agents'>,
  tiers: WorkflowModelTiers,
  defaults: WorkflowModelDefaults = {}
): WorkflowModelTier | undefined {
  return STRONGEST_FIRST.find(
    (tier) =>
      step.agents.length > 0 &&
      step.agents.every((agent) =>
        tiers[tier].some((model) => sameWorkflowModel(agent, model, defaults))
      )
  )
}

/** The tier the whole workflow is on, when every step is on the same one. */
export function workflowSpecTier(
  spec: Pick<WorkflowSpec, 'steps'>,
  tiers: WorkflowModelTiers,
  defaults: WorkflowModelDefaults = {}
): WorkflowModelTier | undefined {
  const found = new Set(spec.steps.map((step) => workflowStepTier(step, tiers, defaults)))
  const [only] = [...found]
  return found.size === 1 ? only : undefined
}
