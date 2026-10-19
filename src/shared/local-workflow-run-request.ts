import { z } from 'zod'
import { localWorkflowLaunchFields } from './local-workflow-launch'
import type { LocalWorkflowFindRequest } from './local-workflow-find-request'
import { WORKFLOW_ROUTES, type WorkflowRoute, type WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { workflowTemplate, type WorkflowTemplateKey } from './workflow-graph-templates'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { applyWorkflowModelPlan } from './workflow-model-plan'
import { DEFAULT_WORKFLOW_MODEL_TIERS, type WorkflowModelTiers } from './workflow-model-tiers'
import { workflowModelsFlagPlan } from './workflow-models-flag'
import {
  WORKFLOW_REQUEST_MAX_CHARS,
  WORKFLOW_REQUESTED_BY_MAX_CHARS,
  workflowRequestedByIdSchema
} from './workflow-agent-launch'

/**
 * The built-in templates `omni workflow run` starts; each is an ordinary graph
 * (workflow-graph-templates.ts). Not `build-review`: graph admission refuses it, because Build +
 * Review runs through its own executor.
 */
export const LOCAL_WORKFLOW_RUN_TEMPLATES = [
  'discover',
  'council',
  'improve',
  'best-of-n',
  'find',
  'decide',
  'investigate',
  'quick-discover'
] as const satisfies readonly WorkflowTemplateKey[]

export type LocalWorkflowRunTemplate = (typeof LOCAL_WORKFLOW_RUN_TEMPLATES)[number]

export const localWorkflowRunRequestSchema = z
  .object({
    ...localWorkflowLaunchFields,
    template: z.enum(LOCAL_WORKFLOW_RUN_TEMPLATES),
    prompt: z.string().trim().min(1).max(32_000),
    /** Only these model families take seats; absent means every family this computer can run. */
    routes: z
      .array(z.enum(WORKFLOW_ROUTES as [WorkflowRoute, ...WorkflowRoute[]]))
      .min(1)
      .max(WORKFLOW_ROUTES.length)
      .optional(),
    /** `--models`: tiers, models or combos per step (workflow-models-flag.ts), laid over the spec. */
    models: z.string().trim().min(1).max(4_000).optional(),
    /** Where the run executes; absent means the fleet, as every preset defaults to. */
    runsOn: z.enum(['fleet', 'local']).optional(),
    /** `--host`: a fleet host by name, read now and refused above 0.8 load per core. */
    host: z.string().trim().min(1).max(253).optional(),
    /** `--force-host <reason>`: a person runs on a busy named host; refused for agent callers. */
    forceHost: z.string().trim().min(1).max(WORKFLOW_REQUEST_MAX_CHARS).optional(),
    /** Who asked, and their words: required when an agent starts the run, frozen with it. */
    requestedBy: z.string().trim().min(1).max(WORKFLOW_REQUESTED_BY_MAX_CHARS).optional(),
    requestedById: workflowRequestedByIdSchema.optional(),
    request: z.string().trim().min(1).max(WORKFLOW_REQUEST_MAX_CHARS).optional(),
    /** `--depth`, Discover only: quick runs one find-and-verify round; absent means thorough. */
    depth: z.enum(['quick', 'thorough']).optional(),
    /** `--no-earlier-runs`: start without the list of what earlier runs on this target found. */
    skipEarlierRuns: z.literal(true).optional(),
    /** `--budget-root <id>`: the approved OmniSI budget root every call of this run spends. */
    budgetRoot: z.string().uuid().optional(),
    focusFinding: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}:[1-9][0-9]{0,3}$/)
      .optional(),
    /**
     * Laid over the template before it is normalized: top-level fields replace the template's;
     * `steps` as an array replaces every step, as an object patches the steps it names by id.
     */
    spec: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export type LocalWorkflowRunRequest = z.infer<typeof localWorkflowRunRequestSchema>

/** What the CLI asks the window to start: Find the best's own request, or any template. */
export type LocalWorkflowStartAsk = LocalWorkflowFindRequest | LocalWorkflowRunRequest

export function isLocalWorkflowRunRequest(
  ask: LocalWorkflowStartAsk
): ask is LocalWorkflowRunRequest {
  return 'template' in ask
}

/** The name a person knows the run by, for errors about starting it. */
export function localWorkflowStartLabel(ask: LocalWorkflowStartAsk): string {
  return isLocalWorkflowRunRequest(ask) ? `The ${ask.template} workflow` : 'Find the best'
}

function overlay(spec: WorkflowSpec, override: Record<string, unknown>): unknown {
  const { steps, ...rest } = override
  if (steps === undefined || Array.isArray(steps)) {
    return { ...spec, ...rest, ...(steps ? { steps } : {}) }
  }
  if (!steps || typeof steps !== 'object') {
    throw new Error('The spec override\'s "steps" must be a list of steps or an object by step id.')
  }
  const patches = steps as Record<string, unknown>
  const unknown = Object.keys(patches).filter((id) => !spec.steps.some((step) => step.id === id))
  if (unknown.length) {
    throw new Error(
      `The spec override names steps the template does not have: ${unknown.join(', ')}. Its steps are ${spec.steps.map((step) => step.id).join(', ')}.`
    )
  }
  return {
    ...spec,
    ...rest,
    steps: spec.steps.map((step) => {
      const patch = patches[step.id]
      return patch && typeof patch === 'object' ? { ...step, ...patch } : step
    })
  }
}

/**
 * The spec a run request asks for over these model families: the template, the override laid
 * over it, normalized and validated as the editor does. `routes` are the families that take
 * seats, and availability is checked against them: pass every route for a structural check
 * before the host has said which families it can run.
 */
export function localWorkflowRunSpec(
  request: LocalWorkflowRunRequest,
  routes: readonly WorkflowRoute[],
  /** The person's tier lineups, for `--models`; absent, the built-in ones. */
  tiers: WorkflowModelTiers = DEFAULT_WORKFLOW_MODEL_TIERS
): WorkflowSpec {
  if (request.focusFinding && request.template !== 'discover') {
    throw new Error('--focus-finding applies to the discover template only.')
  }
  if (request.depth && request.template !== 'discover') {
    throw new Error(`--depth applies to the discover template only, not ${request.template}.`)
  }
  const template = workflowTemplate(request.template, routes, { depth: request.depth })
  if (!request.spec && !request.models) {
    return template
  }
  if (request.spec && 'template' in request.spec && request.spec.template !== request.template) {
    throw new Error('The spec override cannot change which template runs; use --template.')
  }
  const laid = request.spec
    ? normalizeWorkflowSpec(overlay(template, request.spec), routes)
    : template
  const spec = request.models ? withModelsFlag(laid, request.models, routes, tiers) : laid
  const problems = validateWorkflowSpec(spec, { available: routes }).problems
  if (problems.length) {
    throw new Error(
      `The ${request.spec ? 'spec override' : '--models choice'} does not make a valid workflow: ${problems
        .map((problem) =>
          problem.stepId ? `${problem.stepId}: ${problem.message}` : problem.message
        )
        .join('; ')}`
    )
  }
  return spec
}

/** Which models exist is not known here: the host checks every named model at Start. */
function withModelsFlag(
  spec: WorkflowSpec,
  models: string,
  routes: readonly WorkflowRoute[],
  tiers: WorkflowModelTiers
): WorkflowSpec {
  let applied: ReturnType<typeof applyWorkflowModelPlan>
  try {
    applied = applyWorkflowModelPlan(spec, workflowModelsFlagPlan(models), {
      tiers,
      available: routes,
      defaults: {}
    })
  } catch (error) {
    throw new Error(`--models: ${error instanceof Error ? error.message : String(error)}`)
  }
  if ('problems' in applied) {
    throw new Error(`--models: ${applied.problems.join(' ')}`)
  }
  return normalizeWorkflowSpec(applied.spec, routes)
}
