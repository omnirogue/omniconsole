import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { WORKFLOW_FIND_PAGE_SIZE } from '../../../../shared/workflow-find-trail'
import { findOptionText, type FindOption } from './graph-find-pool'
import { readFindScreen, type FindScreen } from './graph-find-rows'
import { GRAPH_JEV_SEAT_ID, type GraphCall, type GraphCallView } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { graphContractKey } from './graph-decision-rules'

function screenCall(
  scope: GraphScope,
  judge: WorkflowStep,
  pool: FindOption[],
  dependencies: string[]
): GraphCall {
  return {
    id: `${judge.id}/screen`,
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_JEV_SEAT_ID,
    dependencies,
    stepId: judge.id,
    round: 1,
    agentIndex: judge.agents.length + 1,
    screen: {
      task: scope.task.prompt,
      rubric: judge.instruction,
      candidates: pool.map((option) => ({
        id: option.key,
        text: findOptionText(option, scope.config.findRules)
      })),
      ...graphContractKey(scope.config, `${judge.id}/screen`)
    },
    validateSemantics: () => null
  }
}

export function screenFindPool(
  scope: GraphScope,
  judge: WorkflowStep,
  pool: FindOption[],
  dependencies: string[],
  views: GraphCallView[]
): FindScreen | { error: string } | 'pending' {
  const paged = (scope.config.findRules ?? 0) >= 3
  const size = paged ? WORKFLOW_FIND_PAGE_SIZE : pool.length
  const combined: FindScreen = { scores: {}, criteria: [] }
  let pending = false
  for (let offset = 0; offset < pool.length; offset += size) {
    const call = screenCall(scope, judge, pool.slice(offset, offset + size), dependencies)
    if (paged) {
      call.id += `/page.${offset / size + 1}`
    }
    scope.calls.push(call)
    const outcome = scope.outcomes.get(call.id)
    views.push({
      id: call.id,
      stepId: judge.id,
      round: 1,
      agentIndex: call.agentIndex,
      seatId: call.seatId,
      jev: true,
      status: outcome ? ('value' in outcome ? 'done' : 'failed') : 'ready'
    })
    if (!outcome) {
      pending = true
      continue
    }
    const read = readFindScreen(outcome)
    if ('error' in read) {
      return read
    }
    if (!paged) {
      return read
    }
    Object.assign(combined.scores, read.scores)
    if (read.unscoredReasons) {
      combined.unscoredReasons = { ...combined.unscoredReasons, ...read.unscoredReasons }
    }
    // Merge by criterion identity in page order, never by completion order.
    for (const criterion of read.criteria) {
      const existing = combined.criteria.find((entry) => entry.id === criterion.id)
      if (existing) {
        Object.assign(existing.scores, criterion.scores)
      } else {
        combined.criteria.push({ ...criterion, scores: { ...criterion.scores } })
      }
    }
  }
  if (pending) {
    return 'pending'
  }
  scope.find!.screening = { options: pool.length, pages: Math.ceil(pool.length / size) }
  return combined
}
