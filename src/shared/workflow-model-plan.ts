import { isOllamaModelTag } from './local-ollama-launch'
import { modelLineage } from './model-lineage'
import { openrouterApiId } from './openrouter-route'
import {
  WORKFLOW_MAX_AGENTS_PER_STEP,
  WORKFLOW_ROUTES,
  workflowKindJudges,
  workflowRouteMayJudge,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep
} from './workflow-graph'
import { readWorkflowCompileJson } from './workflow-graph-compile'
import type { WorkflowPresetModel } from './workflow-model-presets'
import {
  WORKFLOW_MODEL_TIERS,
  isWorkflowModelTier,
  sameWorkflowModel,
  withWorkflowAgentModel,
  withWorkflowStepModels,
  workflowStepTierLineup,
  type WorkflowModelDefaults,
  type WorkflowModelTiers
} from './workflow-model-tiers'

/**
 * Words → models. A person says which models should run which steps ("cheap models for the
 * research, the best one for the final answer, the critics on free OpenRouter models") and one
 * read-only model call answers with a plan. The plan can only change which model an agent runs:
 * steps, instructions, inputs and agent counts are never read from it.
 */
export type WorkflowModelPlanCatalog = {
  /** The models each signed-in family offers for workflows. */
  families: { route: WorkflowRoute; models: { id: string; label: string; isDefault?: boolean }[] }[]
  /** OpenRouter models worth offering by name: free first, then the cheapest. */
  openrouter: { id: string; promptPrice: number; completionPrice: number }[]
  /** Ollama tags installed on this computer. */
  ollama: string[]
}

export type WorkflowModelPlanContext = {
  tiers: WorkflowModelTiers
  available: readonly WorkflowRoute[]
  defaults: WorkflowModelDefaults
  /** What this computer offers. Absent (the CLI, before a host answers): the host checks at Start. */
  catalog?: WorkflowModelPlanCatalog
}

export type WorkflowModelPlanResult = {
  spec: WorkflowSpec
  assumptions: string[]
  /** Ids of the steps whose models changed. */
  changed: string[]
}

export const WORKFLOW_MODEL_PLAN_GUIDE = `You choose which AI models run each step of an Omni-IDE workflow. You change models only: never the steps, their instructions or their inputs. How many agents a step has changes only with "exact" (below).

Tiers are named lineups of models: "cheap", "standard" and "frontier". Use a tier when the user speaks in those terms: cheap, low cost, budget, fast or light means "cheap"; normal, balanced or default means "standard"; best, strongest, smartest or top means "frontier". Name an exact model only when the user names a model or a provider, or asks for free, local or Ollama models.

Answer with one JSON object and nothing else:
{"steps": {"<step id>": {"tier": "cheap"}, "<step id>": {"agents": [{"route": "openrouter", "model": "<id>"}, {"tier": "frontier"}]}}, "assumptions": ["..."]}
- "steps" names only the steps that change. The key "*" means every step not named.
- {"tier": T} puts tier T's lineup on the step. {"agents": [...]} sets the step's agents in order; when it has fewer entries than the step has agents, the entries repeat. An entry is {"tier": T} or {"route": R, "model": M}.
- A combo: {"agents": [...], "exact": true} makes the step run exactly one agent per entry (1 to 8 agents; a synthesize step always has one). Use it when the user lists the models a step should run, or asks for a mix of providers on a step, e.g. "run the finders on Claude, GPT, Grok, DeepSeek and my local Qwen".
- Routes: "claude", "codex" (GPT / OpenAI), "grok", "gemini", "openrouter" and "ollama". "model" is required for "openrouter" (an API id) and for "ollama" (an installed tag); for the others leave it out to use the family's default. Use only the routes and model ids listed below, except an exact OpenRouter id the user typed.
- Review, rank and synthesize steps decide, and Google-family models (Gemini, Gemma, OpenRouter google/*) never decide: give those steps another family.
- List in "assumptions" anything you decided that the user did not say.`

function perMillion(price: number): string {
  return price === 0 ? 'free' : `$${(price * 1_000_000).toFixed(2)}`
}

function modelText(model: WorkflowPresetModel): string {
  return model.model ? `${model.route}:${model.model}` : model.route
}

export function workflowModelPlanPrompt(input: {
  description: string
  spec: WorkflowSpec
  context: WorkflowModelPlanContext
  /** What was wrong with the previous answer, for the one repair turn. */
  problems?: string[]
}): string {
  const { tiers, available } = input.context
  const catalog = input.context.catalog ?? { families: [], openrouter: [], ollama: [] }
  const parts = [
    WORKFLOW_MODEL_PLAN_GUIDE,
    `The workflow's steps:\n${input.spec.steps
      .map(
        (step) =>
          `- ${step.id} (${step.kind}, "${step.title}", ${step.agents.length} agent${step.agents.length === 1 ? '' : 's'}): ${step.agents.map(modelText).join(', ')}`
      )
      .join('\n')}`,
    `Tiers:\n${WORKFLOW_MODEL_TIERS.map((tier) => `- ${tier}: ${tiers[tier].map(modelText).join(', ')}`).join('\n')}`,
    `Families set up on this computer:\n${catalog.families
      .filter((family) => available.includes(family.route))
      .map(
        (family) =>
          `- ${family.route}: ${family.models.map((model) => `${model.id}${model.isDefault ? ' (default)' : ''}`).join(', ')}`
      )
      .join('\n')}`
  ]
  if (available.includes('openrouter')) {
    parts.push(
      `OpenRouter models (price per 1M tokens, in / out):\n${catalog.openrouter
        .map(
          (model) =>
            `- ${model.id}: ${perMillion(model.promptPrice)} / ${perMillion(model.completionPrice)}`
        )
        .join('\n')}`
    )
  }
  if (available.includes('ollama')) {
    parts.push(`Ollama models installed on this computer:\n- ${catalog.ollama.join('\n- ')}`)
  }
  parts.push(`Request:\n${input.description.trim()}`)
  if (input.problems?.length) {
    parts.push(
      `Your previous answer could not be used:\n${input.problems.map((problem) => `- ${problem}`).join('\n')}\nAnswer again with a corrected JSON object.`
    )
  }
  return parts.join('\n\n')
}

function isRoute(value: unknown): value is WorkflowRoute {
  return typeof value === 'string' && (WORKFLOW_ROUTES as readonly string[]).includes(value)
}

/** One plan entry as a model for one agent of one step, or why it cannot be used. */
function plannedModel(
  entry: unknown,
  step: WorkflowStep,
  index: number,
  context: WorkflowModelPlanContext,
  /** The workflow as planned so far: a judge's tier leans away from its inputs' families. */
  spec: WorkflowSpec
): WorkflowPresetModel | string {
  const name = step.title || step.id
  const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
  if (raw.tier !== undefined) {
    if (!isWorkflowModelTier(raw.tier)) {
      return `${name}: "${String(raw.tier)}" is not a tier. Use cheap, standard or frontier.`
    }
    const lineup = workflowStepTierLineup(spec, step, context.tiers[raw.tier], context.available)
    return lineup.length
      ? lineup[index % lineup.length]
      : `${name}: the ${raw.tier} tier has no model this step can use on this computer.`
  }
  if (!isRoute(raw.route)) {
    return `${name}: every agent needs a "tier" or one of the listed routes.`
  }
  const route = raw.route
  if (!context.available.includes(route)) {
    return `${name}: ${route} is not set up on this computer.`
  }
  const typed = typeof raw.model === 'string' ? raw.model.trim() : ''
  let model: string | undefined = typed || undefined
  if (route === 'openrouter') {
    if (!openrouterApiId.safeParse(model).success || modelLineage(route, model) === 'unknown') {
      return `${name}: name an OpenRouter model id from a known family, e.g. one of the listed ones.`
    }
  } else if (route === 'ollama') {
    const installed = context.catalog?.ollama
    if (!isOllamaModelTag(model) || (installed && !installed.includes(model))) {
      return `${name}: "${typed}" is not an Ollama model installed on this computer.`
    }
    if (modelLineage(route, model) === 'unknown') {
      return `${name}: the family of the Ollama model "${typed}" is not recognised.`
    }
  } else if (model && context.catalog) {
    const offered = context.catalog.families.find((family) => family.route === route)?.models ?? []
    const match = offered.find(
      (candidate) =>
        candidate.id === model || candidate.label.toLowerCase() === model!.toLowerCase()
    )
    if (!match) {
      return `${name}: ${route} does not offer "${typed}". Its models are ${offered.map((candidate) => candidate.id).join(', ')}.`
    }
    model = match.id
  }
  if (workflowKindJudges(step.kind) && !workflowRouteMayJudge(route, model)) {
    return `${name}: Google-family models never review, rank or synthesize. Give this step another family.`
  }
  return { route, ...(model ? { model } : {}) }
}

/** Lays one answer over the workflow. Any problem means nothing is applied. */
export function applyWorkflowModelPlan(
  spec: WorkflowSpec,
  answer: Record<string, unknown> | undefined,
  context: WorkflowModelPlanContext
): WorkflowModelPlanResult | { problems: string[] } {
  const steps =
    answer?.steps && typeof answer.steps === 'object' && !Array.isArray(answer.steps)
      ? (answer.steps as Record<string, unknown>)
      : undefined
  if (!steps) {
    return { problems: ['The answer was not a JSON object with "steps".'] }
  }
  const problems: string[] = []
  const unknown = Object.keys(steps).filter(
    (id) => id !== '*' && !spec.steps.some((step) => step.id === id)
  )
  if (unknown.length) {
    problems.push(
      `These are not steps of this workflow: ${unknown.join(', ')}. Its steps are ${spec.steps.map((step) => step.id).join(', ')}.`
    )
  }
  let next = spec
  const changed: string[] = []
  for (const step of spec.steps) {
    const raw = Object.hasOwn(steps, step.id) ? steps[step.id] : steps['*']
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const entry = raw as Record<string, unknown>
    const entries =
      Array.isArray(entry.agents) && entry.agents.length ? entry.agents : [{ tier: entry.tier }]
    const before = next
    const fail = (problem: string) => {
      if (!problems.includes(problem)) {
        problems.push(problem)
      }
    }
    if (entry.exact === true && Array.isArray(entry.agents) && entry.agents.length) {
      const limit = step.kind === 'synthesize' ? 1 : WORKFLOW_MAX_AGENTS_PER_STEP
      if (entries.length > limit) {
        fail(
          `${step.title || step.id}: this step runs at most ${limit} agent${limit === 1 ? '' : 's'}.`
        )
        continue
      }
      const combo = entries.map((item, index) => plannedModel(item, step, index, context, next))
      combo.filter((item): item is string => typeof item === 'string').forEach(fail)
      if (combo.every((item): item is WorkflowPresetModel => typeof item !== 'string')) {
        const same =
          combo.length === step.agents.length &&
          combo.every((item, index) =>
            sameWorkflowModel(step.agents[index], item, context.defaults)
          )
        next = same ? next : withWorkflowStepModels(next, step.id, combo, context.defaults)
      }
    } else {
      step.agents.forEach((agent, index) => {
        const planned = plannedModel(entries[index % entries.length], step, index, context, next)
        if (typeof planned === 'string') {
          fail(planned)
        } else if (!sameWorkflowModel(agent, planned, context.defaults)) {
          next = withWorkflowAgentModel(next, step.id, index, planned, context.defaults)
        }
      })
    }
    if (next !== before) {
      changed.push(step.id)
    }
  }
  if (problems.length) {
    return { problems }
  }
  return {
    spec: next,
    changed,
    assumptions: Array.isArray(answer?.assumptions)
      ? answer.assumptions.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : []
  }
}

/**
 * The whole exchange: ask, apply, and when the answer cannot be used ask once more with what was
 * wrong. `ask` runs the model; the caller decides which agent and account.
 */
export async function compileWorkflowModelPlan(input: {
  description: string
  spec: WorkflowSpec
  context: WorkflowModelPlanContext
  ask: (prompt: string) => Promise<string>
}): Promise<WorkflowModelPlanResult | { error: string }> {
  let silent = false
  const attempt = async (problems?: string[]) => {
    const text = await input.ask(
      workflowModelPlanPrompt({ ...input, ...(problems ? { problems } : {}) })
    )
    silent = !text.trim()
    return applyWorkflowModelPlan(input.spec, readWorkflowCompileJson(text), input.context)
  }
  const first = await attempt()
  // No answer at all (stopped, or the agent failed) is not an answer to repair.
  if (!('problems' in first) || silent) {
    return 'problems' in first ? { error: first.problems[0] } : first
  }
  const second = await attempt(first.problems)
  return 'problems' in second ? { error: second.problems[0] } : second
}
