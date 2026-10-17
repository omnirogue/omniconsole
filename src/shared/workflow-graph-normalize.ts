import { localWorkflowRouteNamesModel } from './local-workflow-seats'
import { workflowRouteRotation } from './workflow-graph-model-rotation'
export { workflowRouteRotation } from './workflow-graph-model-rotation'
import {
  WORKFLOW_DEFAULT_IMPROVE_ROUNDS,
  WORKFLOW_DEFAULT_PATIENCE,
  WORKFLOW_KIND_LABELS,
  WORKFLOW_MAX_AGENTS_PER_STEP,
  WORKFLOW_MAX_IMPROVE_ROUNDS,
  WORKFLOW_MAX_INSTRUCTION_CHARS,
  WORKFLOW_MAX_PATIENCE,
  WORKFLOW_MAX_POPULATION,
  WORKFLOW_MAX_ROUNDS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_SYSTEM_CHARS,
  WORKFLOW_MAX_TITLE_CHARS,
  WORKFLOW_ROUTES,
  WORKFLOW_STEP_ID,
  workflowKindJudges,
  workflowRouteMayJudge,
  type WorkflowAgentSpec,
  type WorkflowRepeat,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowTemplateId
} from './workflow-graph'
import { normalizeImprovePrompts } from './workflow-improve-prompts'
import { normalizeWorkflowCheck } from './workflow-check-normalize'
import {
  normalizeWorkflowJevVerify,
  normalizeWorkflowReviewTriage
} from './workflow-graph-review-triage'
import { normalizeOneAnswer } from './workflow-one-answer'
import { normalizeFinalCheck } from './workflow-council-final-check'
import { normalizeDecideStepFields, WORKFLOW_TEMPLATE_IDS } from './workflow-graph-decide-fields'
import { clampInt, cleanBlock, cleanText } from './workflow-spec-coercion'
import { normalizeWorkflowList } from './workflow-graph-list'
import { normalizeFind } from './workflow-graph-normalize-find'
import { normalizeWorkflowWeb } from './workflow-graph-web'

export function workflowStepSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return /^[a-z]/.test(slug) ? slug : `step-${slug}`.slice(0, 32).replace(/-+$/, '')
}

function isRoute(value: unknown): value is WorkflowRoute {
  return typeof value === 'string' && (WORKFLOW_ROUTES as readonly string[]).includes(value)
}

function isKind(value: unknown): value is WorkflowStepKind {
  return value === 'do' || value === 'review' || value === 'rank' || value === 'synthesize'
}

type RawStep = Record<string, unknown>

function normalizeAgents(
  raw: unknown,
  kind: WorkflowStepKind,
  available: readonly WorkflowRoute[],
  offset: number
): WorkflowAgentSpec[] {
  const rotation = workflowRouteRotation(available, kind)
  const list = Array.isArray(raw) ? raw : []
  const count =
    kind === 'synthesize'
      ? 1
      : clampInt(
          list.length || (typeof raw === 'number' ? raw : 1),
          1,
          WORKFLOW_MAX_AGENTS_PER_STEP,
          1
        )
  return Array.from({ length: count }, (_, index) => {
    const entry = (list[index] ?? {}) as Record<string, unknown>
    const wanted = isRoute(entry.route) ? entry.route : undefined
    const candidateModel = typeof entry.model === 'string' ? entry.model : ''
    // A route that names its model keeps it as typed: validation says what is wrong with it.
    const named = !!wanted && localWorkflowRouteNamesModel(wanted)
    const allowed =
      wanted &&
      (named || available.includes(wanted)) &&
      (named || !workflowKindJudges(kind) || workflowRouteMayJudge(wanted, candidateModel))
    const route = allowed ? wanted : rotation[(offset + index) % rotation.length]
    const model = allowed ? (named ? candidateModel : cleanText(candidateModel, 512)) : ''
    const angle = cleanText(entry.angle, 200)
    const system = cleanBlock(entry.system, WORKFLOW_MAX_SYSTEM_CHARS)
    return {
      route,
      ...(model ? { model } : {}),
      ...(angle ? { angle } : {}),
      ...(system ? { system } : {})
    }
  })
}

/**
 * Turns anything shaped like a workflow (an editor draft, a model's JSON, a saved tab) into a
 * well-formed spec with every default filled in. It never invents structure: steps, kinds and
 * edges come from the input. What it cannot repair (a dangling input, a cycle) stays for
 * `validateWorkflowSpec` to report against the step.
 */
export function normalizeWorkflowSpec(
  raw: unknown,
  available: readonly WorkflowRoute[] = WORKFLOW_ROUTES
): WorkflowSpec {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawSteps = (Array.isArray(record.steps) ? record.steps : []).slice(
    0,
    WORKFLOW_MAX_STEPS * 2
  ) as RawStep[]
  const idMap = new Map<string, string>()
  const used = new Set<string>()
  const ids = rawSteps.map((step, index) => {
    const source = cleanText(step?.id, 64) || cleanText(step?.title, 64) || `step-${index + 1}`
    let id = WORKFLOW_STEP_ID.test(source)
      ? source
      : workflowStepSlug(source) || `step-${index + 1}`
    for (let n = 2; used.has(id); n++) {
      id = `${id.slice(0, 28)}-${n}`
    }
    used.add(id)
    if (typeof step?.id === 'string' && !idMap.has(step.id)) {
      idMap.set(step.id, id)
    }
    return id
  })
  const mapId = (value: unknown): string | undefined =>
    typeof value === 'string' ? (idMap.get(value) ?? value) : undefined
  let judgeOffset = 1
  const steps: WorkflowStep[] = rawSteps.map((step, index) => {
    const kind: WorkflowStepKind = isKind(step?.kind) ? step.kind : 'do'
    const inputs = [
      ...new Set(
        (Array.isArray(step?.inputs) ? step.inputs : [])
          .map(mapId)
          .filter((value): value is string => !!value)
      )
    ]
    const forEachRaw = step?.forEach as Record<string, unknown> | string | undefined
    const forEachStep = mapId(
      typeof forEachRaw === 'string' ? forEachRaw : forEachRaw && (forEachRaw.step as unknown)
    )
    const triage = normalizeWorkflowReviewTriage({
      kind,
      forEachStep,
      forEachRaw,
      escalateRaw: step?.escalate,
      mapId
    })
    const listRaw = step?.list as Record<string, unknown> | boolean | undefined
    const jevRaw = step?.jev as Record<string, unknown> | undefined
    // Reviewers and rankers start one family later than the work; the one synthesizer takes the
    // first eligible family (Claude where it is available).
    const offset = kind === 'synthesize' ? 0 : workflowKindJudges(kind) ? judgeOffset++ : 0
    const title =
      cleanText(step?.title, WORKFLOW_MAX_TITLE_CHARS) ||
      `${WORKFLOW_KIND_LABELS[kind]} ${index + 1}`
    return {
      id: ids[index],
      kind,
      title,
      instruction: cleanBlock(step?.instruction, WORKFLOW_MAX_INSTRUCTION_CHARS),
      agents: normalizeAgents(step?.agents, kind, available, offset),
      // A for-each source is always an input.
      inputs: forEachStep && !inputs.includes(forEachStep) ? [...inputs, forEachStep] : inputs,
      ...(forEachStep
        ? {
            forEach: {
              step: forEachStep,
              limit: triage.limit,
              ...(triage.screen ? { screen: triage.screen } : {}),
              ...(triage.order ? { order: triage.order } : {}),
              ...(triage.merge ? { merge: triage.merge } : {})
            }
          }
        : {}),
      ...(triage.escalate ? { escalate: triage.escalate } : {}),
      ...normalizeWorkflowJevVerify(step?.jevVerify),
      ...normalizeDecideStepFields(step, kind, mapId),
      ...(kind === 'synthesize' && step?.rankItems === true ? { rankItems: true as const } : {}),
      ...(kind === 'synthesize' && step?.rankItems === true && step?.rankEstimates === true
        ? { rankEstimates: true as const }
        : {}),
      ...(kind === 'synthesize' && step?.claimTable === true ? { claimTable: true as const } : {}),
      ...(kind === 'rank' &&
      jevRaw &&
      typeof jevRaw === 'object' &&
      (jevRaw.method === 'auto' || jevRaw.method === 'rubric' || jevRaw.method === 'pairwise')
        ? { jev: { method: jevRaw.method, ...(jevRaw.only === true ? { only: true } : {}) } }
        : {}),
      ...(kind === 'do' && listRaw ? { list: normalizeWorkflowList(listRaw) } : {}),
      // Kept on any kind, so validation refuses a judge that asks to read pages instead of hiding it.
      ...normalizeWorkflowWeb(step?.web)
    }
  })
  const repeatRaw = record.repeat as Record<string, unknown> | undefined
  const repeat: WorkflowRepeat | undefined =
    repeatRaw && typeof repeatRaw === 'object' ? normalizeRepeat(repeatRaw, mapId) : undefined
  const template = WORKFLOW_TEMPLATE_IDS.has(record.template as WorkflowTemplateId)
    ? (record.template as WorkflowTemplateId)
    : 'custom'
  const find = normalizeFind(record.find)
  return {
    version: 1,
    title: cleanText(record.title, WORKFLOW_MAX_TITLE_CHARS) || 'Workflow',
    template,
    steps,
    ...(repeat ? { repeat } : {}),
    ...(find ? { find } : {}),
    ...normalizeFinalCheck(record.finalCheck, mapId),
    ...normalizeOneAnswer(record.oneAnswer, mapId)
  }
}

function normalizeRepeat(
  raw: Record<string, unknown>,
  mapId: (value: unknown) => string | undefined
): WorkflowRepeat {
  const until =
    raw.until === 'nothing-new' || raw.until === 'plateau' ? raw.until : ('approved' as const)
  const base = { do: mapId(raw.do) ?? '', review: mapId(raw.review) ?? '' }
  if (until !== 'plateau') {
    return {
      ...base,
      until,
      maxRounds: clampInt(raw.maxRounds, 1, WORKFLOW_MAX_ROUNDS, 3),
      ...(until === 'nothing-new' &&
      Number.isInteger(raw.minConfirmedForRound2) &&
      Number(raw.minConfirmedForRound2) > 0
        ? { minConfirmedForRound2: Math.min(1000, Number(raw.minConfirmedForRound2)) }
        : {})
    }
  }
  return {
    ...base,
    until,
    maxRounds: clampInt(
      raw.maxRounds,
      1,
      WORKFLOW_MAX_IMPROVE_ROUNDS,
      WORKFLOW_DEFAULT_IMPROVE_ROUNDS
    ),
    patience: clampInt(raw.patience, 1, WORKFLOW_MAX_PATIENCE, WORKFLOW_DEFAULT_PATIENCE),
    explore: raw.explore === 'low' || raw.explore === 'high' ? raw.explore : 'normal',
    ...normalizeWorkflowCheck(raw.check, true),
    ...normalizeImprovePrompts(raw.prompts),
    ...normalizePopulation(raw.population),
    ...normalizeFrontier(raw.frontier)
  }
}

/** Never added by default: a spec saved without frontier models replays as it ran. */
function normalizeFrontier(raw: unknown): Pick<WorkflowRepeat, 'frontier'> {
  const list: unknown[] = Array.isArray(raw) ? raw.slice(0, WORKFLOW_ROUTES.length) : []
  const frontier = list.flatMap((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    const model = cleanText(record.model, 512)
    return isRoute(record.route) && model ? [{ route: record.route, model }] : []
  })
  return frontier.length ? { frontier } : {}
}

/** One version to build on is the default, so it is never saved and old specs stay as saved. */
function normalizePopulation(raw: unknown): Pick<WorkflowRepeat, 'population'> {
  const population = typeof raw === 'number' ? clampInt(raw, 1, WORKFLOW_MAX_POPULATION, 1) : 1
  return population > 1 ? { population } : {}
}
