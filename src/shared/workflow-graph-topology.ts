import {
  councilFinalCheckDescription,
  councilFinalCheckSteps
} from './workflow-council-final-check'
import { decideGuardDescription } from './workflow-decide-guard'
import { WORKFLOW_FIND_PAGE_SIZE } from './workflow-find-trail'
import { findJudgeStep, findOptionsStep } from './workflow-graph-find'
import { workflowImproveHostCalls } from './workflow-improve-host-calls'
import {
  WORKFLOW_MAX_CRITERIA,
  workflowStepReadsWeb,
  type WorkflowSpec,
  type WorkflowStep
} from './workflow-graph'
import { oneAnswerDescription } from './workflow-one-answer'

export type WorkflowTopology = {
  /** Topological order, or null when the graph has a cycle or a dangling input. */
  order: string[] | null
  /** Longest distance from a step with no inputs; the column a step is drawn in. */
  level: Map<string, number>
  consumers: Map<string, string[]>
  /** Steps nothing consumes, but a one-answer route's own step. A valid graph has one. */
  sinks: string[]
}

export function workflowTopology(
  spec: Pick<WorkflowSpec, 'steps' | 'oneAnswer'>
): WorkflowTopology {
  const byId = new Map(spec.steps.map((step) => [step.id, step]))
  const consumers = new Map<string, string[]>(spec.steps.map((step) => [step.id, []]))
  for (const step of spec.steps) {
    for (const input of step.inputs) {
      consumers.get(input)?.push(step.id)
    }
  }
  const indegree = new Map(
    spec.steps.map((step) => [step.id, step.inputs.filter((input) => byId.has(input)).length])
  )
  const queue = spec.steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id)
  const order: string[] = []
  const level = new Map<string, number>()
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    const step = byId.get(id)!
    level.set(
      id,
      step.inputs.reduce((max, input) => Math.max(max, (level.get(input) ?? -1) + 1), 0)
    )
    for (const consumer of consumers.get(id) ?? []) {
      const left = (indegree.get(consumer) ?? 0) - 1
      indegree.set(consumer, left)
      if (left === 0) {
        queue.push(consumer)
      }
    }
  }
  const dangling = spec.steps.some((step) => step.inputs.some((input) => !byId.has(input)))
  return {
    order: order.length === spec.steps.length && !dangling ? order : null,
    level,
    consumers,
    sinks: spec.steps
      .filter((step) => !consumers.get(step.id)?.length && step.id !== spec.oneAnswer?.step)
      .map((step) => step.id)
  }
}

/** Every step downstream of `id` (not including it). */
export function workflowDescendants(spec: Pick<WorkflowSpec, 'steps'>, id: string): Set<string> {
  const { consumers } = workflowTopology(spec)
  const seen = new Set<string>()
  const stack = [...(consumers.get(id) ?? [])]
  while (stack.length) {
    const next = stack.pop()!
    if (!seen.has(next)) {
      seen.add(next)
      stack.push(...(consumers.get(next) ?? []))
    }
  }
  return seen
}

export function workflowFinalStep(spec: WorkflowSpec): WorkflowStep | undefined {
  const { sinks } = workflowTopology(spec)
  return sinks.length === 1 ? spec.steps.find((step) => step.id === sinks[0]) : undefined
}

// ─── Planning ───────────────────────────────────────────────────────────────

/**
 * Whether an escalating review can give a first review that gave no answer to a stand-in
 * (graphStandIns): only an agent on another provider stands in.
 */
function hasStandIn(step: WorkflowStep): boolean {
  return !!step.escalate?.standIn && new Set(step.agents.map((agent) => agent.route)).size > 1
}

/**
 * The most results one run of a step can produce for its consumers: agents' texts, or a list's
 * items (before dedup, after the for-each cap of whoever consumes it).
 */
function stepOutputCount(step: WorkflowStep, runs: Map<string, number>): number {
  return (runs.get(step.id) ?? 1) * step.agents.length * (step.list ? step.list.maxItems : 1)
}

/**
 * The call upper bound (including Find host calls): the host refuses a graph whose bound exceeds
 * WORKFLOW_MAX_CALLS, and the setup shows it before Start. `runs` counts how many times a step
 * runs in one round (its for-each items), then repeat rounds multiply the loop's two steps.
 */
export function planWorkflowCalls(spec: WorkflowSpec): {
  total: number
  /** Calls a model answers; excludes the host work below. */
  agentTotal: number
  /** Host work (Find's pages, Improve's checks, quote checks, the web read): never an agent. */
  hostTotal: number
  perStep: Record<string, number>
} {
  const topology = workflowTopology(spec)
  const byId = new Map(spec.steps.map((step) => [step.id, step]))
  const runs = new Map<string, number>()
  const perStep: Record<string, number> = {}
  let hostTotal = 0
  for (const id of topology.order ?? spec.steps.map((step) => step.id)) {
    const step = byId.get(id)!
    let instances = 1
    if (step.forEach) {
      const source = byId.get(step.forEach.step)
      const repeat = spec.repeat
      // A step after a nothing-new repeat reads every round's items together; the loop's own
      // review reads one round's at a time.
      const rounds =
        repeat?.until === 'nothing-new' && repeat.do === source?.id && repeat.review !== id
          ? repeat.maxRounds
          : 1
      const produced = source ? stepOutputCount(source, runs) * rounds : 0
      instances = Math.min(step.forEach.limit, produced)
    }
    runs.set(id, instances)
    const rounds =
      spec.repeat && (spec.repeat.do === id || spec.repeat.review === id)
        ? spec.repeat.maxRounds
        : 1
    // One reviewer per item, the others only for up to `max` escalated items a round, and a
    // stand-in for up to `max` first reviews a round that gave no answer; a comparison by
    // criterion may call every agent twice (both orders) per rubric line.
    // An impact triage adds at most one call a round, made only when items exceed the limit.
    const triage = step.forEach?.order === 'impact' ? 1 : 0
    const orders = step.byCriterion ? 2 * WORKFLOW_MAX_CRITERIA : 1
    const more = step.agents.length - 1 + (hasStandIn(step) ? 1 : 0)
    perStep[id] = step.escalate
      ? (instances + Math.min(step.escalate.max, instances) * more + triage) * rounds
      : (instances * step.agents.length * orders + triage) * rounds
    // The app's quote check (graph-evidence-plan.ts): one host call a round, never an agent.
    const quotes =
      step.kind === 'review' && step.forEach && byId.get(step.forEach.step)?.list?.evidence
        ? rounds
        : 0
    perStep[id] += quotes
    hostTotal += quotes
  }
  const check = councilFinalCheckSteps(spec)
  if (check) {
    // Decide's skeptic checks what would ship, and once more a finalist shown in its place.
    perStep[check.rank.id] += check.rank.agents.length + (spec.finalCheck?.skeptic ? 2 : 0)
  }
  const options = findOptionsStep(spec)
  const judge = findJudgeStep(spec)
  const improveHost = workflowImproveHostCalls(spec)
  if (improveHost) {
    hostTotal += improveHost
    perStep[spec.repeat!.do] = (perStep[spec.repeat!.do] ?? 0) + improveHost
  }
  if (spec.find && options && judge) {
    const pool = spec.find.items?.length ?? stepOutputCount(options, runs)
    const screens = pool > spec.find.top ? Math.ceil(pool / WORKFLOW_FIND_PAGE_SIZE) : 0
    const checks = spec.find.versions && spec.find.check ? pool : 0
    // Host calls, never an agent: each screen page, version checks, the person's GitHub search,
    // repository facts, the final ballot.
    const findHost = screens + checks + (spec.find.harvest ? 1 : 0) + 2
    hostTotal += findHost
    perStep[judge.id] = (perStep[judge.id] ?? 0) + findHost
    if (spec.find.items) {
      perStep[options.id] = 0
    }
  }
  const firstReader = (topology.order ?? spec.steps.map((step) => step.id)).find((id) =>
    workflowStepReadsWeb(byId.get(id)!)
  )
  if (firstReader) {
    // One host call reads every page of the run, once, before its first reader.
    hostTotal += 1
    perStep[firstReader] += 1
  }
  const total = Object.values(perStep).reduce((sum, value) => sum + value, 0)
  return { total, agentTotal: total - hostTotal, hostTotal, perStep }
}

/**
 * The agent calls kept for the final step once a run admits no other new work (Finish now, or
 * Max agents reached). Undefined where ending early is not always well defined: no single final
 * step, a final Rank (one surviving answer has nothing to rank), Find the best's own pipeline, or
 * a repeat other than "until nothing new" (a skipped revision would leave no review to report).
 */
export function workflowFinishReserve(
  spec: WorkflowSpec
): { finalStepId: string; reserve: number } | undefined {
  const final = workflowFinalStep(spec)
  if (
    !final ||
    final.kind === 'rank' ||
    spec.find ||
    (spec.repeat && spec.repeat.until !== 'nothing-new') ||
    spec.repeat?.do === final.id ||
    spec.repeat?.review === final.id
  ) {
    return undefined
  }
  const reserve = planWorkflowCalls(spec).perStep[final.id] ?? 0
  return reserve > 0 ? { finalStepId: final.id, reserve } : undefined
}

/** The step a graph call id (`step[/r<round>][/<item>]/a<agent>`) belongs to. */
export function workflowCallStepId(callId: string): string {
  return callId.split('/')[0]
}

/**
 * A call that ends the run, kept reserved when it finishes early: the final step's, or the
 * one-answer step's. The route decides which one runs, so one reserve covers both.
 */
export function workflowTerminalCall(spec: WorkflowSpec, callId: string): boolean {
  const step = workflowCallStepId(callId)
  return step === workflowFinishReserve(spec)?.finalStepId || step === spec.oneAnswer?.step
}

// ─── Readback ───────────────────────────────────────────────────────────────

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** One plain-English line per step, in run order: what the compiler shows back to the user. */
export function describeWorkflow(spec: WorkflowSpec): string[] {
  const byId = new Map(spec.steps.map((step) => [step.id, step]))
  const order = (workflowTopology(spec).order ?? spec.steps.map((step) => step.id)).filter(
    (id) => id !== spec.oneAnswer?.step
  )
  const lines = order.map((id) => {
    const step = byId.get(id)!
    const title = (other: string) => byId.get(other)?.title ?? other
    if (step.byCriterion) {
      const answers = step.inputs.filter((input) => input !== step.byCriterion!.rubricFrom)
      return `${step.title}: JEV compares the answers from ${answers.map(title).join(' and ')} on each rubric line of ${title(step.byCriterion.rubricFrom)}, in both orders; ${plural(step.agents.length, 'agent')} rank a line, also in both orders, only where JEV is unsure, and a line they still disagree on is left out as a gap.`
    }
    // An escalating review starts with one reviewer per item; the rest are named after.
    const one = step.agents.length === 1 || !!step.escalate
    const who = one ? '1 agent' : `${step.agents.length} agents`
    const each = step.forEach
      ? ` for each item from ${byId.get(step.forEach.step)?.title ?? step.forEach.step}`
      : ''
    const from = step.inputs.filter((input) => input !== step.forEach?.step)
    const reads = from.length
      ? ` using ${from.map((input) => byId.get(input)?.title ?? input).join(' and ')}`
      : ''
    const verb =
      step.kind === 'do'
        ? step.list
          ? one
            ? 'lists items'
            : 'list items in parallel'
          : one
            ? 'works'
            : 'work in parallel'
        : step.kind === 'review'
          ? one
            ? 'reviews'
            : 'review in parallel'
          : step.kind === 'rank'
            ? one
              ? 'ranks the answers blind'
              : 'rank the answers blind, in parallel'
            : step.rankItems
              ? 'writes the report and ranks the results by value, each with why and a next step'
              : step.claimTable
                ? 'writes the final answer with a table of confirmed, refuted and open claims'
                : 'writes the final answer'
    const screen = step.forEach?.screen?.shortlist
      ? "on a varied shortlist JEV picks: options that break a hard limit are dropped, then the best overall, each rubric line's leader and one wildcard"
      : [
          step.forEach?.screen ? 'after JEV sets aside non-items' : '',
          step.forEach?.merge === 'root-cause' ? 'with repeats of one root cause merged' : '',
          step.forEach?.order === 'impact'
            ? 'most important first'
            : step.forEach?.screen
              ? 'best first'
              : ''
        ]
          .filter(Boolean)
          .join(', ')
    const escalate = step.escalate
      ? `; ${step.escalate.crossFamily ? 'the first reviewer is from another model family than the finder, and ' : ''}the other ${plural(step.agents.length - 1, 'agent')} join on up to ${plural(step.escalate.max, 'item')} a round that do not pass or are critical${hasStandIn(step) ? `; when a first review gives no answer, an agent on another provider reviews the item instead, on up to ${plural(step.escalate.max, 'item')} a round` : ''}`
      : ''
    const close = step.whenClose
      ? `, only when the top two of ${byId.get(step.whenClose)?.title ?? step.whenClose} are close`
      : ''
    const table = step.claimTable
      ? '; a claim stays open unless the fact-check it reads confirmed it and it names its evidence'
      : ''
    return `${step.title}: ${who} ${verb}${each}${reads}${screen ? `, ${screen}` : ''}${escalate}${close}${table}.`
  })
  if (spec.repeat) {
    const doStep = byId.get(spec.repeat.do)?.title ?? spec.repeat.do
    const review = byId.get(spec.repeat.review)?.title ?? spec.repeat.review
    const most = plural(spec.repeat.maxRounds, 'round')
    lines.push(
      spec.repeat.until === 'approved'
        ? `${doStep} and ${review} repeat until the reviewers approve, at most ${most}.`
        : spec.repeat.until === 'plateau'
          ? `${doStep} and ${review} repeat, keeping the best version so far, until ${plural(spec.repeat.patience ?? 2, 'round')} in a row bring no improvement, at most ${most}.`
          : `${doStep} and ${review} repeat until a round finds nothing new, at most ${most}.`
    )
  }
  if (spec.finalCheck) {
    lines.push(
      byId.get(spec.finalCheck.rank)?.byCriterion
        ? decideGuardDescription()
        : councilFinalCheckDescription()
    )
  }
  if (spec.oneAnswer) {
    lines.unshift(oneAnswerDescription())
  }
  const readers = spec.steps.filter(workflowStepReadsWeb)
  if (readers.length) {
    const pages = new Set(readers.flatMap((step) => step.web!.urls)).size
    const one = readers.length === 1
    lines.unshift(
      `The app reads ${plural(pages, 'web page')} once, before any step uses them; only ${readers.map((step) => step.title).join(' and ')} ${one ? 'reads' : 'read'} their text, and every other step sees only what ${one ? 'its' : 'their'} agents wrote.`
    )
  }
  lines.push(`Up to ${plural(planWorkflowCalls(spec).agentTotal, 'agent call')}.`)
  return lines
}
