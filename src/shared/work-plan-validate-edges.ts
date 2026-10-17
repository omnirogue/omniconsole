import {
  isWorkPlanOutcomeGate,
  workPlanNodeGroup,
  workPlanNodeSeatCount,
  workPlanOutcomeOf,
  workPlanProducers,
  type WorkPlan,
  type WorkPlanNode,
  type WorkPlanProblem
} from './work-plan-types'

/** Reading edges, verdict consumers and grouping: the rules that keep the graph acyclic and spent. */
function block(code: string, nodeId: string, message: string): WorkPlanProblem {
  return { code, nodeId, message, severity: 'block' }
}

function earlierIds(plan: WorkPlan, node: WorkPlanNode): Set<string> {
  const index = plan.nodes.findIndex((entry) => entry.id === node.id)
  return new Set(plan.nodes.slice(0, Math.max(0, index)).map((entry) => entry.id))
}

function readingProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  if (node.kind === 'finish') {
    return []
  }
  const problems: WorkPlanProblem[] = []
  const known = new Set(plan.nodes.map((entry) => entry.id))
  const earlier = earlierIds(plan, node)
  for (const id of node.readsFrom ?? []) {
    if (!known.has(id)) {
      problems.push(
        block(
          'reads-from-unknown',
          node.id,
          `${node.id} reads from ${id}, which is not a step of this plan.`
        )
      )
      continue
    }
    if (!earlier.has(id)) {
      problems.push(
        block(
          'reads-from-not-earlier',
          node.id,
          `${node.id} reads from ${id}, which does not run before it. A step only reads work that is already finished.`
        )
      )
    }
  }
  const winner = node.kind === 'worker' ? node.readsWinnerOf : undefined
  if (!winner) {
    return problems
  }
  const source = plan.nodes.find((entry) => entry.id === winner)
  if (!source) {
    problems.push(
      block(
        'reads-winner-of-unknown',
        node.id,
        `${node.id} reads the winner of ${winner}, which is not a step of this plan.`
      )
    )
  } else if (!earlier.has(winner)) {
    problems.push(
      block(
        'reads-winner-of-not-earlier',
        node.id,
        `${node.id} reads the winner of ${winner}, which does not run before it.`
      )
    )
  } else if (source.kind === 'finish' || source.verdict?.consumed !== 'select-winner') {
    problems.push(
      block(
        'reads-winner-of-not-select-winner',
        node.id,
        `${node.id} reads the winner of ${winner}, but ${winner} picks no winner. Give it a verdict that selects one.`
      )
    )
  }
  return problems
}

function verdictConsumed(plan: WorkPlan, node: WorkPlanNode): boolean {
  const later = plan.nodes.slice(plan.nodes.findIndex((entry) => entry.id === node.id) + 1)
  const consumption = node.kind === 'finish' ? undefined : node.verdict?.consumed
  if (consumption === 'select-winner') {
    return later.some(
      (entry) =>
        entry.kind === 'worker' &&
        (entry.enabledBy?.verdict === node.id || entry.readsWinnerOf === node.id)
    )
  }
  if (consumption === 'record') {
    return later.some((entry) => entry.kind !== 'finish' && entry.readsFrom?.includes(node.id))
  }
  // A gate at the end of a plan still decides whether the outcome may finish.
  return later.length > 0
}

const UNCONSUMED_FIX: Record<string, string> = {
  'select-winner': 'Have a later step read its winner, or gate a later group on it.',
  record: 'Have a later step name it in what it reads.',
  gate: 'Put the work it gates after it.'
}

/**
 * A verify step is measured against the OUTCOME, not against another step: its `over` names
 * done-when entries and it gates what follows. Everything else ranges over the work it read.
 */
function outcomeGateProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  const verdict = node.kind === 'finish' ? undefined : node.verdict
  if (!verdict) {
    return []
  }
  const problems: WorkPlanProblem[] = []
  const stated = new Set(workPlanOutcomeOf(plan).doneWhen.map((entry) => entry.id))
  if (verdict.consumed !== 'gate') {
    problems.push(
      block(
        'verify-verdict-not-gate',
        node.id,
        `${node.id} checks the work against what done means, so it gates what follows it.`
      )
    )
  }
  for (const id of verdict.over) {
    if (!stated.has(id)) {
      problems.push(
        block(
          'verify-over-done-when',
          node.id,
          `${node.id} checks ${id}, which is not one of this outcome's done-when entries.`
        )
      )
    }
  }
  return problems
}

function failRouteProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  if (node.kind !== 'worker' || !node.onFail) {
    return []
  }
  const onFail = node.onFail
  if (node.verdict?.consumed !== 'gate') {
    return [
      block(
        'fail-route-not-gate',
        node.id,
        `${node.id} routes a failure without deciding anything. Only a gate can fail.`
      )
    ]
  }
  const target = plan.nodes.find((entry) => entry.id === onFail)
  if (!target) {
    return [
      block(
        'verify-fail-route-unknown',
        node.id,
        `${node.id} sends a failure to ${onFail}, which is not a step of this plan.`
      )
    ]
  }
  return target.kind === 'worker' && (target.role === 'repair' || target.role === 'improve')
    ? []
    : [
        block(
          'verify-fail-route-not-repair',
          node.id,
          `${node.id} sends a failure to ${onFail}, which does not repair anything. Send it to a repair or improve step, or let the failure block the outcome.`
        )
      ]
}

function verdictProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  const verdict = node.kind === 'finish' ? undefined : node.verdict
  if (!verdict) {
    return []
  }
  const problems: WorkPlanProblem[] = []
  const known = new Set(plan.nodes.map((entry) => entry.id))
  const read = new Set(workPlanProducers(plan, node).map((entry) => entry.id))
  if (verdict.over.length === 0) {
    problems.push(
      block(
        'verdict-over-empty',
        node.id,
        `${node.id} issues a verdict over nothing. Name what it judges.`
      )
    )
  }
  if (isWorkPlanOutcomeGate(node)) {
    problems.push(...outcomeGateProblems(plan, node))
  } else {
    for (const id of verdict.over) {
      if (!known.has(id)) {
        problems.push(
          block(
            'verdict-over-unknown',
            node.id,
            `${node.id} judges ${id}, which is not a step of this plan.`
          )
        )
      } else if (!read.has(id)) {
        problems.push(
          block(
            'verdict-over-not-read',
            node.id,
            `${node.id} judges ${id} without reading it. A verdict only ranges over work its own step was given.`
          )
        )
      }
    }
  }
  if (!verdictConsumed(plan, node)) {
    problems.push(
      block(
        'verdict-unconsumed',
        node.id,
        `Nothing uses ${node.id}'s verdict. ${UNCONSUMED_FIX[verdict.consumed]}`
      )
    )
  }
  return problems
}

/**
 * Why only select-winner and gate: those two change what runs next, so a seat of theirs could
 * complete through a cohort while a sibling completes through a skip. A `record` verdict changes
 * no control flow, which is what makes a Council's ⑂N critique legal. A review node is exempt
 * because fanning its reviewers out IS the review-round primitive, which finishes its own group.
 */
function groupingProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  const problems: WorkPlanProblem[] = []
  const verdict = node.kind === 'finish' ? undefined : node.verdict
  const decides = verdict?.consumed === 'select-winner' || verdict?.consumed === 'gate'
  if (decides && node.kind === 'worker' && workPlanNodeSeatCount(node) > 1) {
    problems.push(
      block(
        'verdict-node-parallel',
        node.id,
        `${node.id} decides; a deciding step runs once, not side by side. Give it one seat.`
      )
    )
  }
  if (decides && node.kind === 'worker' && node.group) {
    problems.push(
      block(
        'verdict-node-in-group',
        node.id,
        `${node.id} decides; a deciding step never shares a group with the work it decides on.`
      )
    )
  }
  const enabledBy = node.kind === 'worker' ? node.enabledBy : undefined
  if (!enabledBy) {
    return problems
  }
  const gate = plan.nodes.find((entry) => entry.id === enabledBy.verdict)
  const seats = plan.nodes.find((entry) => entry.id === enabledBy.seatsOf)
  if (!gate) {
    problems.push(
      block(
        'enabled-by-unknown-verdict',
        node.id,
        `${node.id} waits on ${enabledBy.verdict}, which is not a step of this plan.`
      )
    )
  } else if (gate.kind === 'finish' || gate.verdict?.consumed !== 'select-winner') {
    problems.push(
      block(
        'enabled-by-not-select-winner',
        node.id,
        `${node.id} waits on ${enabledBy.verdict}, which picks no winner. Only a winner can enable seats.`
      )
    )
  } else if (workPlanNodeGroup(gate) && workPlanNodeGroup(gate) === workPlanNodeGroup(node)) {
    problems.push(
      block(
        'enabled-by-shares-group',
        node.id,
        `${node.id} waits on ${enabledBy.verdict} from inside its own group; the two would launch together.`
      )
    )
  }
  if (!seats) {
    problems.push(
      block(
        'enabled-by-unknown-seats',
        node.id,
        `${node.id} waits on the seats of ${enabledBy.seatsOf}, which is not a step of this plan.`
      )
    )
  } else if (workPlanNodeSeatCount(seats) < 2) {
    problems.push(
      block(
        'enabled-by-seats-not-parallel',
        node.id,
        `${node.id} waits on the seats of ${enabledBy.seatsOf}, which runs one seat. A winner is chosen among several.`
      )
    )
  }
  return problems
}

export function workPlanEdgeProblems(plan: WorkPlan): WorkPlanProblem[] {
  return plan.nodes.flatMap((node) => [
    ...readingProblems(plan, node),
    ...verdictProblems(plan, node),
    ...failRouteProblems(plan, node),
    ...groupingProblems(plan, node)
  ])
}
