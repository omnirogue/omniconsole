import type { AgentAccountChoice } from './agent-account-profiles'
import type { HandoffArtifactReview } from './handoff-artifact-review'
import {
  consoleWorkflowLoopKind,
  consoleWorkflowLoopStopRule,
  CONSOLE_WORKFLOW_LOOP_MAX_ROUNDS
} from './console-workflow-loop'
import type { NextStepActor } from './next-step-draft'
import type { NextOutcomeTeamUsableAgent } from './next-outcome-team-plan-schema'
import type { SessionActionPresetId } from './session-action-presets'
import type { SessionChainSource } from './session-chain-policy'
import type { SessionChain, SessionChainStepStage } from './session-chain-types'

/**
 * The authoring model of one work plan: what the person drew in the composer, before it is
 * lowered into outcome steps. Frozen on day 0 — every other package codes against these names.
 * INFORMATION → ACTION → TOPOLOGY → CONVERGENCE → ROUTE → INFORMATION.
 */
export type WorkPlanRole =
  | 'research'
  | 'plan'
  | 'analyze'
  | 'implement'
  | 'improve'
  | 'critique'
  | 'review'
  | 'verify'
  | 'compare'
  | 'judge'
  | 'synthesize'
  | 'summarize'
  | 'test'
  | 'repair'

export const WORK_PLAN_ROLES = [
  'research',
  'plan',
  'analyze',
  'implement',
  'improve',
  'critique',
  'review',
  'verify',
  'compare',
  'judge',
  'synthesize',
  'summarize',
  'test',
  'repair'
] as const satisfies readonly WorkPlanRole[]

/** Roles that read and report. Everything else may write the workspace itself. */
export const WORK_PLAN_READ_ONLY_ROLES = [
  'research',
  'analyze',
  'plan',
  'critique',
  'review',
  'judge',
  'compare',
  'synthesize',
  'summarize',
  'verify'
] as const satisfies readonly WorkPlanRole[]

/** v1 offers new-session and human; same-session needs the wave-3 route the host reports. */
export type WorkPlanRoute = 'new-session' | 'human' | 'same-session'

export const WORK_PLAN_ROUTES = [
  'new-session',
  'human',
  'same-session'
] as const satisfies readonly WorkPlanRoute[]

export type WorkPlanVerdictKind = 'review' | 'judge' | 'verify' | 'critique'

/**
 * How the verdict is spent: pick a winner among `over`, gate what follows, or record a
 * receipt a later node reads. A verdict with no consumer never runs.
 */
export type WorkPlanVerdictConsumption = 'select-winner' | 'gate' | 'record'

export type WorkPlanVerdict = {
  kind: WorkPlanVerdictKind
  /** The node ids this verdict ranges over; a judge ranks exactly these. */
  over: string[]
  consumed: WorkPlanVerdictConsumption
}

/** This node runs only for the seats of `seatsOf` that `verdict` selected. */
export type WorkPlanEnabledBy = { verdict: string; seatsOf: string }

export type WorkPlanWrites = 'own-output-dir' | 'workspace'

export type WorkPlanActor = NextStepActor

type WorkPlanSeatedNode = {
  id: string
  /**
   * The composer stage this node belongs to. One shape may mint several nodes (a council is
   * answers ×N → critiques ×N → judge → winner); they share one stage, so the person edits
   * and reads ONE block. Stamped by `workPlanFromShape`/`appendWorkPlanFragment`, carried to
   * every compiled seat, and read back from the chain.
   */
  stage?: SessionChainStepStage
  /** The seat that runs this node; `seats` names one actor per seat when `count > 1`. */
  actor: WorkPlanActor
  /** One actor per seat, so a cycled duplicate is shown rather than hidden. */
  seats?: WorkPlanActor[]
  route?: WorkPlanRoute
  /** Absent means every earlier node; present means exactly these. */
  readsFrom?: string[]
  verdict?: WorkPlanVerdict
}

export type WorkPlanWorkerNode = WorkPlanSeatedNode & {
  kind: 'worker'
  role: WorkPlanRole
  /** Typed instruction; empty falls back to the role's preset default when it compiles. */
  instruction: string
  /** ×N mints N seats sharing one group. */
  count?: number
  group?: string
  readsWinnerOf?: string
  enabledBy?: WorkPlanEnabledBy
  writes?: WorkPlanWrites
  /** Where a failed gate sends the work; absent means a failure blocks the outcome. */
  onFail?: string
}

/**
 * A loop's vocabulary is the hub's, not a second one: a work plan's review loop and a
 * card-attached hub loop say the same words, so one can become the other without a mapping.
 */
export const WORK_PLAN_REVIEW_KINDS = consoleWorkflowLoopKind.options
export type WorkPlanReviewKind = (typeof WORK_PLAN_REVIEW_KINDS)[number]
export const WORK_PLAN_REVIEW_STOP_RULES = consoleWorkflowLoopStopRule.options
export type WorkPlanReviewStop = (typeof WORK_PLAN_REVIEW_STOP_RULES)[number]
export const WORK_PLAN_MAX_REVIEW_ROUNDS = CONSOLE_WORKFLOW_LOOP_MAX_ROUNDS

/** One review round over ONE candidate, repeated up to `maxRounds`; not a Council. */
export type WorkPlanReviewNode = WorkPlanSeatedNode & {
  kind: 'review'
  loop: WorkPlanReviewKind
  readsFrom: string[]
  maxRounds: number
  stop: WorkPlanReviewStop
  verdict: WorkPlanVerdict
  instruction?: string
}

/**
 * Where the work goes when the plan finishes. `people` is the Up next Person block: a
 * HANDOFF moves ownership to one person and ends the track; a REVIEW asks one or several
 * people for feedback and the track continues, which is why every one of them gets their
 * own request and their own condition when this lowers.
 */
export type WorkPlanFinishPeople = {
  people: { id: string; name: string }[]
  disposition: 'ownership' | 'feedback'
  /** What the request asks for; `review` is the ask coming back, not a transfer. */
  action?: 'review' | 'approve' | 'decide' | 'edit' | 'fyi'
  /**
   * What they receive beside the final summary. A card is created only when asked for.
   * `dueAt` is when the ask is due (ISO with offset), carried onto the handoff rule.
   */
  receive?: {
    files?: boolean
    transcript?: boolean
    note?: string
    taskId?: string
    dueAt?: string
    /** An omnios page the people are asked to decide on (`handoff-artifact-review.ts`). */
    artifact?: HandoffArtifactReview
  }
}

export type WorkPlanFinishNode = {
  kind: 'finish'
  id: string
  how: 'complete' | 'my-review'
  route?: WorkPlanRoute
  /** Present when the plan finishes at a person rather than at the person who asked. */
  finishWith?: WorkPlanFinishPeople
}

export type WorkPlanNode = WorkPlanWorkerNode | WorkPlanReviewNode | WorkPlanFinishNode

export type WorkPlanOutputKind = 'work' | 'plan' | 'mockup'

export type WorkPlanDoneWhenEvidence = 'file' | 'report' | 'verdict' | 'human' | 'command'

/** Mirrors `condition.verification`: the host runs this and compares what it printed. */
export type WorkPlanDoneWhenCommand = {
  program: string
  args: string[]
  expectedStdout?: string
}

/**
 * One testable statement of the desired state. `path` names the file when the evidence is one;
 * `command` names what the host runs when the evidence is a check it can run itself. A settled
 * session, a finished attempt and an existing file prove nothing: only a receipt against one of
 * these entries, at the Outcome's current revision, is progress.
 */
export type WorkPlanDoneWhen = {
  id: string
  text: string
  evidence: WorkPlanDoneWhenEvidence
  path?: string
  command?: WorkPlanDoneWhenCommand
}

/**
 * The desired state, above the chain and never inside it. Everything below -- action, actor,
 * topology, convergence, route -- is configuration of a transform stage, not a peer of this.
 *
 * A Conversation is Message → Response and carries no Outcome; it holds zero, one or many
 * Outcomes over its lifetime, one per pursuit. A pursuit is STANDALONE by default: an Outcome
 * needs no Task. A Task is an OPTIONAL long-running container that may hold many Outcomes, so
 * `taskRef` is many-to-one, optional, and no rule may assume one exists; `outcomeId` and
 * `revision` let a pursuit be attached to a Task later by writing one reference, never by
 * re-running or copying its history. Exactly one Outcome controls completion of one execution.
 */
export type WorkPlanOutcome = {
  title: string
  doneWhen: WorkPlanDoneWhen[]
  outputKind: WorkPlanOutputKind
  /** The Task container this plan is attached to, when one exists. */
  taskRef?: string
  outcomeId?: string
  revision?: number
}

/** OUTCOME → INFORMATION → TRANSFORM → NEW INFORMATION → VERIFY AGAINST THE OUTCOME. */
export type WorkPlan = {
  outcome: WorkPlanOutcome
  source?: { conversationId: string }
  nodes: WorkPlanNode[]
}

export type WorkPlanContext = {
  usableAgents: NextOutcomeTeamUsableAgent[]
  source: SessionChainSource | null
  placement: 'local' | 'card'
  accountCatalogue: AgentAccountChoice[]
  existingChain?: SessionChain
  commitSource: 'user' | 'ai' | 'library' | 'proposer'
  capabilities: { sameConversationRoute: boolean }
}

export type WorkPlanProblem = {
  code: string
  nodeId?: string
  message: string
  severity: 'block' | 'warn'
}

/**
 * Depth cap: consecutive seats of one group fold to one stage, so this counts handoffs, not
 * seats. It is width-blind on its own — WORK_PLAN_MAX_SEATS is the companion width guard, and
 * removing either one lets an unbounded fan-out through the other.
 */
export const WORK_PLAN_MAX_STAGES = 6
export const WORK_PLAN_MAX_SEATS = 24
/** An AI-authored plan gets the narrower team budget the hub already enforces. */
export const WORK_PLAN_MAX_AI_SEATS = 8

/** Every role compiles through a preset, so no node can reach the chain with an empty prompt. */
export const WORK_PLAN_ROLE_PRESET: Record<WorkPlanRole, SessionActionPresetId> = {
  research: 'research',
  plan: 'plan',
  analyze: 'analyze',
  implement: 'implement',
  improve: 'improve',
  critique: 'critique',
  review: 'review',
  verify: 'verify',
  compare: 'compare',
  judge: 'judge',
  synthesize: 'synthesize',
  summarize: 'summarize',
  test: 'test',
  repair: 'repair'
}

/**
 * The one read of a plan's outcome. Everything that needs the desired state goes through here,
 * so a plan that SERVES a durable Outcome can resolve it in one place instead of in every rule.
 */
export function workPlanOutcomeOf(plan: WorkPlan): WorkPlanOutcome {
  return plan.outcome
}

export function isWorkPlanWorkerNode(node: WorkPlanNode): node is WorkPlanWorkerNode {
  return node.kind === 'worker'
}

/** The step that measures the work against the outcome, rather than against another step. */
export function isWorkPlanOutcomeGate(node: WorkPlanNode): node is WorkPlanWorkerNode {
  return node.kind === 'worker' && node.role === 'verify'
}

/** Seats one node mints: ×N workers, or a review node's reviewers per round plus its repairs. */
export function workPlanNodeSeatCount(node: WorkPlanNode): number {
  if (node.kind === 'finish') {
    return 0
  }
  if (node.kind === 'review') {
    const rounds = Math.max(1, Math.trunc(node.maxRounds))
    return Math.max(1, node.seats?.length ?? 1) * rounds + (rounds - 1)
  }
  return Math.max(1, Math.trunc(node.count ?? 1))
}

/** The actor of each seat; a node with no per-seat list runs every seat on the same actor. */
export function workPlanNodeActors(node: WorkPlanNode): WorkPlanActor[] {
  if (node.kind === 'finish') {
    return []
  }
  const total = node.kind === 'worker' ? Math.max(1, Math.trunc(node.count ?? 1)) : 1
  return node.seats?.length ? [...node.seats] : Array.from({ length: total }, () => node.actor)
}

/** The nodes whose result feeds `node`: exactly `readsFrom`, else every earlier node. */
export function workPlanProducers(plan: WorkPlan, node: WorkPlanNode): WorkPlanNode[] {
  const index = plan.nodes.findIndex((entry) => entry.id === node.id)
  const earlier = plan.nodes.slice(0, index === -1 ? plan.nodes.length : index)
  if (node.kind === 'finish' || !node.readsFrom) {
    return earlier.filter((entry) => entry.kind !== 'finish')
  }
  const ids = new Set(node.readsFrom)
  return earlier.filter((entry) => ids.has(entry.id))
}

/** A ×N node mints one group of its own; an explicit group tag names a shared one. */
export function workPlanNodeGroup(node: WorkPlanNode): string | undefined {
  if (node.kind !== 'worker') {
    return undefined
  }
  return node.group ?? (workPlanNodeSeatCount(node) > 1 ? node.id : undefined)
}

/** Seats that launch beside this one: its own seats plus every node sharing its group. */
export function workPlanParallelSeats(plan: WorkPlan, node: WorkPlanNode): number {
  const group = workPlanNodeGroup(node)
  if (!group) {
    return workPlanNodeSeatCount(node)
  }
  return plan.nodes
    .filter((entry) => workPlanNodeGroup(entry) === group)
    .reduce((total, entry) => total + workPlanNodeSeatCount(entry), 0)
}

export function workPlanSeatTotal(plan: WorkPlan): number {
  return plan.nodes.reduce((total, node) => total + workPlanNodeSeatCount(node), 0)
}

/** Stages = handoffs: consecutive seats of one group fold into one. */
export function workPlanStageCount(plan: WorkPlan): number {
  let stages = 0
  let previousGroup: string | undefined
  for (const node of plan.nodes) {
    if (node.kind === 'finish') {
      continue
    }
    const group = node.kind === 'worker' ? node.group : undefined
    if (!group || group !== previousGroup) {
      stages += 1
    }
    previousGroup = group
  }
  return stages
}
