import { localWorkflowRouteNamesModel } from './local-workflow-seats'
import { modelLineage } from './model-lineage'
import {
  WORKFLOW_DEFAULT_IMPROVE_ROUNDS,
  WORKFLOW_DEFAULT_PATIENCE,
  WORKFLOW_MAX_RANK_CANDIDATES,
  WORKFLOW_ROUTES,
  workflowRouteMayJudge,
  type WorkflowAgentSpec,
  type WorkflowJevJudge,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep
} from './workflow-graph'

/** One version at a time by default; more compete in parallel (Best of N). */
export const IMPROVE_DEFAULT_CANDIDATES = 1
/** The best version so far is always one of the judged answers, so N challengers + 1. */
export const IMPROVE_MAX_CANDIDATES = WORKFLOW_MAX_RANK_CANDIDATES - 1
const MULTI_JUDGES = 3

/** JEV first: it decides when it is sure; the model judges step in when it is not. */
export const JEV_FIRST: WorkflowJevJudge = { method: 'auto', only: true }

/** Fast multi-family OpenEvolve lineup: Haiku 5.5 + Gemini 3.8 Flash + Codex Luna. */
export const FAST_EVOLVE_MODELS: readonly WorkflowAgentSpec[] = [
  { route: 'claude', model: 'claude-haiku-5-5' },
  { route: 'gemini', model: 'gemini-3.8-flash' },
  { route: 'codex', model: 'gpt-6-luna' }
]

/** Frontier multi-family OpenEvolve lineup: Argon primary + Opus 5.5 + Codex Astra. */
export const FRONTIER_EVOLVE_MODELS: readonly WorkflowAgentSpec[] = [
  { route: 'gemini', model: 'gemini-4-argon' },
  { route: 'claude', model: 'opus' },
  { route: 'codex', model: 'gpt-6-astra' }
]

/** One model does the work (the default), or the work rotates across every available family. */
export type ImproveModels =
  | { mode: 'single'; route: WorkflowRoute; model?: string }
  | { mode: 'multi'; models?: WorkflowAgentSpec[] }

export function fastImproveModels(available: readonly WorkflowRoute[]): ImproveModels {
  const list = FAST_EVOLVE_MODELS.filter((spec) => available.includes(spec.route))
  return { mode: 'multi', models: list.length ? [...list] : [{ ...FAST_EVOLVE_MODELS[0] }] }
}

export function isFastImproveModels(models: ImproveModels): boolean {
  if (models.mode !== 'multi' || !models.models?.length) {
    return false
  }
  const fastSet = new Set(FAST_EVOLVE_MODELS.map((spec) => `${spec.route}:${spec.model}`))
  return models.models.every((spec) => fastSet.has(`${spec.route}:${spec.model ?? ''}`))
}

export function frontierImproveModels(available: readonly WorkflowRoute[]): ImproveModels {
  const list = improveFrontier(available)
  return { mode: 'multi', models: list.length ? [...list] : [{ ...FRONTIER_EVOLVE_MODELS[0] }] }
}

export function isFrontierImproveModels(models: ImproveModels): boolean {
  if (models.mode !== 'multi' || !models.models?.length) {
    return false
  }
  const frontierSet = new Set(FRONTIER_EVOLVE_MODELS.map((spec) => `${spec.route}:${spec.model}`))
  return models.models.every((spec) => frontierSet.has(`${spec.route}:${spec.model ?? ''}`))
}

export function families(available: readonly WorkflowRoute[]): WorkflowRoute[] {
  // OpenRouter and Ollama have no default model, so they never fill a rotation by themselves.
  const list = WORKFLOW_ROUTES.filter(
    (route) => !localWorkflowRouteNamesModel(route) && available.includes(route)
  )
  return list.length ? list : ['claude']
}

/** Improvers for N candidates: one model, or one family after another. */
function improvers(
  models: ImproveModels,
  available: readonly WorkflowRoute[],
  count: number,
  keep: readonly WorkflowAgentSpec[] = []
): WorkflowAgentSpec[] {
  const total = Math.min(Math.max(Math.round(count), 1), IMPROVE_MAX_CANDIDATES)
  const rotation: WorkflowAgentSpec[] =
    models.mode === 'multi' && models.models?.length
      ? models.models
      : families(available).map((route) => ({ route }))
  return Array.from({ length: total }, (_, index) => {
    const chosen = models.mode === 'single' ? models : rotation[index % rotation.length]
    const { route } = chosen
    const kept = keep[index]
    // A seat keeps its own system prompt (and model, when the family is unchanged).
    return {
      route,
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(!chosen.model && kept?.route === route && kept.model ? { model: kept.model } : {}),
      ...(kept?.system ? { system: kept.system } : {})
    }
  })
}

/**
 * Judges who stand in when JEV cannot decide. One model working alone is judged by another
 * family when there is one (a model prefers its own newest revision; the estate rule is that the
 * maker never judges its own work); multi-model work by up to three families, with one from
 * outside the makers' when every maker that may judge is of one family.
 */
export function fallbackJudges(
  models: ImproveModels,
  available: readonly WorkflowRoute[]
): WorkflowAgentSpec[] {
  const eligible = families(available).filter((route) => workflowRouteMayJudge(route))
  if (models.mode === 'multi' && models.models?.length) {
    const eligibleModels = models.models.filter((model) =>
      workflowRouteMayJudge(model.route, model.model)
    )
    const independent = [
      ...new Map(
        eligibleModels.map((model) => [modelLineage(model.route, model.model), model])
      ).values()
    ]
    // One family judging alone would rank its own makers' work with no second opinion.
    const makers = new Set(models.models.map((model) => modelLineage(model.route, model.model)))
    const outside =
      independent.length === 1
        ? eligible.find((route) => !makers.has(modelLineage(route)))
        : undefined
    if (independent.length) {
      return [...independent, ...(outside ? [{ route: outside }] : [])].slice(0, MULTI_JUDGES)
    }
  }
  const list = eligible.length ? eligible : (['claude'] as WorkflowRoute[])
  if (models.mode === 'single') {
    const other = list.find(
      (route) => modelLineage(route) !== modelLineage(models.route, models.model)
    )
    return [
      {
        route: other ?? (workflowRouteMayJudge(models.route, models.model) ? models.route : list[0])
      }
    ]
  }
  return list.slice(0, MULTI_JUDGES).map((route) => ({ route }))
}

/** Each family's frontier model here: improvers move to it after a round without gain. */
export function improveFrontier(available: readonly WorkflowRoute[]): WorkflowAgentSpec[] {
  return FRONTIER_EVOLVE_MODELS.filter((spec) => available.includes(spec.route)).map((spec) => ({
    ...spec
  }))
}

/**
 * Improve: keep making the work better until more attempts stop helping. Each round the
 * improvers make challengers to the best version so far, judges compare them blind, and a
 * challenger replaces it only when it wins; after a round without gain they move to frontier
 * models. Everything is a default and every setting optional.
 */
export function improveWorkflow(
  available: readonly WorkflowRoute[],
  candidates = IMPROVE_DEFAULT_CANDIDATES,
  models: ImproveModels = { mode: 'single', route: families(available)[0] }
) {
  const frontier = improveFrontier(available)
  return {
    title: 'Improve',
    template: 'improve',
    steps: [
      {
        id: 'improve',
        kind: 'do',
        title: 'Improve',
        instruction: '',
        agents: improvers(models, available, candidates),
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: fallbackJudges(models, available),
        inputs: ['improve'],
        jev: JEV_FIRST
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds: WORKFLOW_DEFAULT_IMPROVE_ROUNDS,
      patience: WORKFLOW_DEFAULT_PATIENCE,
      explore: 'normal',
      ...(frontier.length ? { frontier } : {})
    }
  }
}

/** The Do step an Improve loop repeats, when the workflow has one. */
export function improveStep(spec: WorkflowSpec): WorkflowStep | undefined {
  return spec.repeat?.until === 'plateau'
    ? spec.steps.find((step) => step.id === spec.repeat!.do)
    : undefined
}

/**
 * An agent whose model a person chose (a tier, a combo, a pick): such a lineup is kept as it is
 * when an option changes, where families left on their defaults are rebuilt from the rotation.
 */
export function namesModel(agent: WorkflowAgentSpec): boolean {
  return !!agent.model || localWorkflowRouteNamesModel(agent.route)
}

/** Single when every improver is the same family, otherwise multi. */
export function improveModelsOf(spec: WorkflowSpec): ImproveModels | undefined {
  const step = improveStep(spec)
  if (!step) {
    return undefined
  }
  const routes = new Set(step.agents.map((agent) => `${agent.route}:${agent.model ?? ''}`))
  return routes.size === 1
    ? { mode: 'single', route: step.agents[0].route, model: step.agents[0].model }
    : step.agents.some(namesModel)
      ? { mode: 'multi', models: step.agents.map(({ route, model }) => ({ route, model })) }
      : { mode: 'multi' }
}

/** "Use 5 candidates", "Use Grok", "Multi-model": the improvers and their stand-in judges. */
export function workflowSetImprove(
  spec: WorkflowSpec,
  change: { candidates?: number; models?: ImproveModels },
  available: readonly WorkflowRoute[]
): WorkflowSpec {
  const step = improveStep(spec)
  const judge = spec.steps.find((entry) => entry.id === spec.repeat?.review)
  if (!step || !judge) {
    return spec
  }
  const models = change.models ?? improveModelsOf(spec)!
  const count = change.candidates ?? step.agents.length
  const agents = improvers(models, available, count, step.agents)
  const judges = change.models ? fallbackJudges(models, available) : judge.agents
  return {
    ...spec,
    steps: spec.steps.map((entry) =>
      entry.id === step.id
        ? { ...entry, agents }
        : entry.id === judge.id
          ? { ...entry, agents: judges }
          : entry
    )
  }
}

export type WorkflowJudges = 'jev' | 'models' | 'both'

export function workflowJudgesOf(jev: WorkflowJevJudge | undefined): WorkflowJudges {
  return !jev ? 'models' : jev.only ? 'jev' : 'both'
}

/** Keeps a chosen JEV method when switching between JEV and Both. */
export function workflowJevFor(
  judges: WorkflowJudges,
  current: WorkflowJevJudge | undefined
): WorkflowJevJudge | undefined {
  const method = current?.method ?? 'auto'
  return judges === 'models' ? undefined : judges === 'jev' ? { method, only: true } : { method }
}
