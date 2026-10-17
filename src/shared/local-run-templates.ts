import {
  LOCAL_RUN_MAX_CONCURRENT,
  type LocalRunActor,
  type LocalRunGraph,
  type LocalRunNode
} from './local-run-graph'
import type { SessionActionPresetId } from './session-action-presets'

/**
 * Seed graphs a person can start from on the canvas. They are folder-first: every
 * shape works on a plain folder of material (a brief, footage, notes) and none of
 * them assumes a repository, a branch or a card. The preset carries the instruction
 * for each step, so a template only has to say which steps exist and what feeds what.
 *
 * These are LOCAL seeds. Templates for work admitted through the console come from
 * the server and are never invented here.
 */
export type LocalRunTemplateId =
  | 'research-plan-produce-review-verify'
  | 'fan-out-synthesize'
  | 'improve-steps'

export const LOCAL_RUN_TEMPLATE_IDS = [
  'research-plan-produce-review-verify',
  'fan-out-synthesize',
  'improve-steps'
] as const satisfies readonly LocalRunTemplateId[]

/** Templates whose width/length a person chooses (fan-out branches, improve steps). */
export const LOCAL_RUN_TEMPLATE_COUNTED: readonly LocalRunTemplateId[] = [
  'fan-out-synthesize',
  'improve-steps'
]

export const LOCAL_RUN_TEMPLATE_DEFAULT_COUNT = 3
export const LOCAL_RUN_TEMPLATE_MAX_COUNT = 8

export type LocalRunTemplateInput = {
  /** Absolute path of the workspace folder. Git optional. */
  workspacePath: string
  /** The actor every seeded node starts with; each node can be changed afterwards. */
  actor: LocalRunActor
  /** What the person wants done. Each node's preset supplies its own role instruction. */
  objective: string
  /** Branches for the fan-out, steps for the improve chain. Ignored by fixed shapes. */
  count?: number
}

export function isLocalRunTemplateId(value: unknown): value is LocalRunTemplateId {
  return typeof value === 'string' && (LOCAL_RUN_TEMPLATE_IDS as readonly string[]).includes(value)
}

function clampCount(count: number | undefined, minimum: number): number {
  const wanted = Number.isInteger(count) ? (count as number) : LOCAL_RUN_TEMPLATE_DEFAULT_COUNT
  return Math.min(Math.max(wanted, minimum), LOCAL_RUN_TEMPLATE_MAX_COUNT)
}

function seedNode(
  input: LocalRunTemplateInput,
  id: string,
  presetId: SessionActionPresetId,
  deps: string[]
): LocalRunNode {
  return { id, actor: input.actor, presetId, objective: input.objective, deps }
}

/** Research → Plan → Produce → Review loop → Verify. */
function researchPlanProduceReviewVerify(input: LocalRunTemplateInput): LocalRunGraph {
  return {
    workspacePath: input.workspacePath,
    nodes: [
      seedNode(input, 'research', 'research', []),
      seedNode(input, 'plan', 'plan', ['research']),
      seedNode(input, 'produce', 'implement', ['plan']),
      seedNode(input, 'review', 'review', ['produce']),
      seedNode(input, 'verify', 'verify', ['review'])
    ]
  }
}

/** Fan-out → Synthesize: N branches that can run at once, then one node that folds them. */
function fanOutSynthesize(input: LocalRunTemplateInput): LocalRunGraph {
  const branches = clampCount(input.count, 2)
  const branchIds = Array.from({ length: branches }, (_, index) => `branch-${index + 1}`)
  return {
    workspacePath: input.workspacePath,
    maxConcurrent: Math.min(branches, LOCAL_RUN_MAX_CONCURRENT),
    nodes: [
      ...branchIds.map((id) => seedNode(input, id, 'implement', [])),
      seedNode(input, 'synthesize', 'synthesize', branchIds)
    ]
  }
}

/** Improve × N: the same improve preset applied N times, each on the previous result. */
function improveSteps(input: LocalRunTemplateInput): LocalRunGraph {
  const steps = clampCount(input.count, 1)
  return {
    workspacePath: input.workspacePath,
    nodes: Array.from({ length: steps }, (_, index) =>
      seedNode(input, `improve-${index + 1}`, 'improve', index === 0 ? [] : [`improve-${index}`])
    )
  }
}

const BUILDERS: Record<LocalRunTemplateId, (input: LocalRunTemplateInput) => LocalRunGraph> = {
  'research-plan-produce-review-verify': researchPlanProduceReviewVerify,
  'fan-out-synthesize': fanOutSynthesize,
  'improve-steps': improveSteps
}

export function localRunTemplateGraph(
  id: LocalRunTemplateId,
  input: LocalRunTemplateInput
): LocalRunGraph {
  return BUILDERS[id](input)
}
