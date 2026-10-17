import {
  WORKFLOW_FIND_DEFAULT_COUNT,
  WORKFLOW_FIND_DEFAULT_KEEP,
  WORKFLOW_FIND_DEFAULT_TOP,
  WORKFLOW_FIND_DEFAULT_VERSIONS,
  WORKFLOW_FIND_MAX_COUNT,
  WORKFLOW_MAX_AGENTS_PER_STEP,
  WORKFLOW_MAX_LIST_ITEMS,
  type WorkflowAgentSpec,
  type WorkflowFind,
  type WorkflowFindItem,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep
} from './workflow-graph'
import {
  fallbackJudges,
  families,
  JEV_FIRST,
  namesModel,
  type ImproveModels
} from './workflow-graph-improve'
import { splitFindItems } from './workflow-find-items'

// Each batch looks from its own angle, so a hundred options are not a hundred variations.
const ANGLES = [
  'the strongest, most obvious options',
  'options most people would overlook',
  'the simplest options that would still work',
  'the most ambitious options',
  'options borrowed from a different field',
  'twists on well-known options',
  'options for a specific niche',
  'the most unconventional options'
]

export const BEST_OF_N_GENERATE_INSTRUCTION =
  'Produce a complete, finished version of what the task asks for, ready to use as it is. Take the angle you are given, but never at the expense of doing what the task asks. Return only the finished work, with no preamble.'

/** How the candidates differ by default; each generator takes one, so the versions are not copies. */
export const BEST_OF_N_ANGLES = [
  'the most direct, complete version',
  'a bold, original take',
  'the most rigorous, carefully checked version',
  'the simplest version a busy reader gets at once',
  'the most persuasive version',
  'a version for an expert reader'
] as const

export const FIND_OPTIONS_INSTRUCTION =
  'Come up with distinct options for the task below: as many as the list allows, every one specific and different from the others. Each option gets a short title that names it, and a detail of one to three sentences on what it is and why it could be the best. When an option is a code repository, its title starts with the GitHub owner/name, so its live facts can be fetched. Leave location empty and severity "none".'

/** One list call per batch, as even as possible. */
export function findBatches(count: number): { batches: number; perBatch: number } {
  const total = Math.min(Math.max(Math.round(count), 2), WORKFLOW_FIND_MAX_COUNT)
  const batches = Math.min(Math.ceil(total / WORKFLOW_MAX_LIST_ITEMS), WORKFLOW_MAX_AGENTS_PER_STEP)
  return { batches, perBatch: Math.ceil(total / batches) }
}

function makers(
  models: ImproveModels,
  available: readonly WorkflowRoute[],
  batches: number,
  keep: readonly WorkflowAgentSpec[] = [],
  angles: readonly string[] = ANGLES
): WorkflowAgentSpec[] {
  const rotation: WorkflowAgentSpec[] =
    models.mode === 'multi' && models.models?.length
      ? models.models
      : families(available).map((route) => ({ route }))
  return Array.from({ length: batches }, (_, index) => {
    const chosen = models.mode === 'single' ? models : rotation[index % rotation.length]!
    const { route } = chosen
    const kept = keep[index]
    return {
      route,
      angle: kept?.angle ?? angles[index % angles.length]!,
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(!chosen.model && kept?.route === route && kept.model ? { model: kept.model } : {}),
      ...(kept?.system ? { system: kept.system } : {})
    }
  })
}

/**
 * Find the best: the models come up with many options (or the person gives a list), JEV scores
 * every one against what good means, and the best few meet head to head. Several families come
 * up with options when they can, for variety; everything is a default and every setting optional.
 */
export function findWorkflow(
  available: readonly WorkflowRoute[],
  count = WORKFLOW_FIND_DEFAULT_COUNT
) {
  const routes = families(available)
  const models: ImproveModels =
    routes.length > 1 ? { mode: 'multi' } : { mode: 'single', route: routes[0]! }
  const { batches, perBatch } = findBatches(count)
  return {
    title: 'Find the best',
    template: 'find',
    steps: [
      {
        id: 'options',
        kind: 'do',
        title: 'Options',
        instruction: FIND_OPTIONS_INSTRUCTION,
        agents: makers(models, available, batches),
        inputs: [],
        list: { maxItems: perBatch }
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: fallbackJudges(models, available),
        inputs: ['options'],
        jev: JEV_FIRST
      }
    ],
    find: { count, top: WORKFLOW_FIND_DEFAULT_TOP, keep: WORKFLOW_FIND_DEFAULT_KEEP }
  }
}

/** The Do step that makes the pool: a list of options, or one complete version per model. */
export function findOptionsStep(spec: WorkflowSpec): WorkflowStep | undefined {
  const versions = !!spec.find?.versions
  return spec.find
    ? spec.steps.find((step) => step.kind === 'do' && !step.list === versions)
    : undefined
}

/** The Rank step that judges the options. */
export function findJudgeStep(spec: WorkflowSpec): WorkflowStep | undefined {
  const options = findOptionsStep(spec)
  return options
    ? spec.steps.find((step) => step.kind === 'rank' && step.inputs.includes(options.id))
    : undefined
}

/** Single when every batch is the same family, otherwise multi. */
export function findModelsOf(spec: WorkflowSpec): ImproveModels | undefined {
  const options = findOptionsStep(spec)
  if (!options) {
    return undefined
  }
  const routes = new Set(options.agents.map((agent) => `${agent.route}:${agent.model ?? ''}`))
  return routes.size === 1
    ? { mode: 'single', route: options.agents[0]!.route, model: options.agents[0]!.model }
    : options.agents.some(namesModel)
      ? { mode: 'multi', models: options.agents.map(({ route, model }) => ({ route, model })) }
      : { mode: 'multi' }
}

/** The step that makes the pool, rebuilt for short options (in list batches) or versions. */
function poolStep(
  step: WorkflowStep,
  find: WorkflowFind,
  models: ImproveModels,
  available: readonly WorkflowRoute[],
  keep: readonly WorkflowAgentSpec[]
): WorkflowStep {
  const { list: _list, ...rest } = step
  if (find.versions) {
    return {
      ...rest,
      // The person's own instruction stays; the other mode's default does not.
      instruction:
        step.instruction === FIND_OPTIONS_INSTRUCTION
          ? BEST_OF_N_GENERATE_INSTRUCTION
          : step.instruction,
      agents: makers(models, available, find.count, keep, BEST_OF_N_ANGLES)
    }
  }
  const { batches, perBatch } = findBatches(find.count)
  return {
    ...rest,
    instruction:
      step.instruction === BEST_OF_N_GENERATE_INSTRUCTION
        ? FIND_OPTIONS_INSTRUCTION
        : step.instruction,
    agents: makers(models, available, batches, keep),
    list: { maxItems: perBatch }
  }
}

/**
 * Changes Find the best's settings: short options or complete versions, how many to come up
 * with (one batch per list call, or one model call per version), the person's own list (null
 * removes it), how many meet in the final, how many to bring back, and which models make them.
 */
export function workflowSetFind(
  spec: WorkflowSpec,
  change: Partial<
    Omit<
      WorkflowFind,
      'items' | 'itemDetails' | 'importMerged' | 'importReceipt' | 'versions' | 'check' | 'harvest'
    >
  > & {
    /** The person's own list, given the request-level way (plain titles or {title,detail,url}). */
    items?: readonly WorkflowFindItem[] | null
    /** How this exact list was actually imported (from the UI or CLI's own parse), whether or not
     * any row carries detail/url. Its merged count is filled in from the real dedupe below. */
    importReceipt?: WorkflowFind['importReceipt'] | null
    versions?: boolean
    /** The person's check for every version; null removes it. Only complete versions keep one. */
    check?: WorkflowFind['check'] | null
    /** The person's GitHub search; null removes it. Only the person ever sets one. */
    harvest?: WorkflowFind['harvest'] | null
    models?: ImproveModels
  },
  available: readonly WorkflowRoute[]
): WorkflowSpec {
  const options = findOptionsStep(spec)
  const judge = findJudgeStep(spec)
  if (!spec.find || !options || !judge) {
    return spec
  }
  const {
    items: _items,
    itemDetails: _itemDetails,
    importMerged: _importMerged,
    importReceipt: _importReceipt,
    versions: _versions,
    check: _check,
    harvest: _harvest,
    ...kept
  } = spec.find
  const check = change.check === null ? undefined : (change.check ?? spec.find.check)
  const harvest = change.harvest === null ? undefined : (change.harvest ?? spec.find.harvest)
  const split =
    change.items === null
      ? undefined
      : change.items
        ? (() => {
            const fresh = splitFindItems(change.items!)
            // A receipt only ever comes from a real import (the UI's or CLI's own parse of a
            // file): its read/skipped record is kept exactly, and only its merged count is ours
            // to fill in from the actual dedupe just above. Typing a list by hand, with no
            // importReceipt given, gets no fabricated receipt — independent of itemDetails
            // either way, so a title-only import still keeps the receipt it was given.
            const receipt =
              change.importReceipt === null || change.importReceipt === undefined
                ? undefined
                : { ...change.importReceipt, merged: fresh.merged }
            return { ...fresh, receipt }
          })()
        : spec.find.items
          ? {
              items: spec.find.items,
              itemDetails: spec.find.itemDetails,
              merged: spec.find.importMerged,
              receipt: spec.find.importReceipt
            }
          : undefined
  // The person's own list is used as given; nothing is written.
  const versions = !split && (change.versions ?? !!spec.find.versions)
  const switched = versions !== !!spec.find.versions
  const count =
    change.count ??
    (switched
      ? versions
        ? WORKFLOW_FIND_DEFAULT_VERSIONS
        : WORKFLOW_FIND_DEFAULT_COUNT
      : spec.find.count)
  const find: WorkflowFind = {
    ...kept,
    count: versions ? Math.min(Math.max(count, 2), WORKFLOW_MAX_AGENTS_PER_STEP) : count,
    ...(versions ? { versions: true as const, ...(check ? { check } : {}) } : {}),
    // A repository is a candidate option, never a complete version somebody wrote.
    ...(!versions && harvest ? { harvest } : {}),
    ...(change.top !== undefined ? { top: change.top } : {}),
    ...(change.keep !== undefined ? { keep: change.keep } : {}),
    ...(split
      ? {
          items: split.items,
          ...(split.itemDetails ? { itemDetails: split.itemDetails } : {}),
          // The merge count and the receipt travel together, independent of itemDetails: a
          // title-only import still gets both.
          ...(split.receipt ? { importMerged: split.merged, importReceipt: split.receipt } : {})
        }
      : {})
  }
  const models = change.models ?? findModelsOf(spec)!
  const fresh = switched || !!change.models
  return {
    ...spec,
    find,
    steps: spec.steps.map((step) =>
      step.id === options.id
        ? poolStep(step, find, models, available, fresh ? [] : step.agents)
        : step.id === judge.id && change.models
          ? { ...step, agents: fallbackJudges(models, available) }
          : step
    )
  }
}
