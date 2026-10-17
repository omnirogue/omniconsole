import { createHash } from 'node:crypto'
import type { DecisionRequest } from '../../../../shared/structured-decisions'
import {
  decideOneAnswerRoute,
  oneAnswerNote,
  ONE_ANSWER_QUESTION,
  ONE_ANSWER_UNSURE_BAND
} from '../../../../shared/workflow-one-answer'
import { jevDecide } from '../../../structured-decisions/jev-rank'
import { fitJevText } from '../../../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../../../structured-decisions/typesafe-provider'
import type { GraphJevOptions } from './graph-jev'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphOutcome, GraphRouteRequest } from './graph-plan-types'
import { contractPolicy } from './graph-decision-rules'

export const GRAPH_ROUTE_CAPABILITY = 'workflow.route'
/** The most of the question JEV reads; a longer question is never routed on a part of it. */
export const GRAPH_ROUTE_MAX_BYTES = 8_000

/** Why JEV cannot read the whole question, or undefined when it can. */
export function graphRouteTooLong(request: GraphRouteRequest): string | undefined {
  return fitJevText(request.question, GRAPH_ROUTE_MAX_BYTES) === request.question
    ? undefined
    : `the question is longer than the ${GRAPH_ROUTE_MAX_BYTES.toLocaleString('en-US')} bytes JEV reads whole`
}

/** The question and band a route is read by: its frozen contract's, else today's constants. */
function routePolicy(request: GraphRouteRequest) {
  return request.contract
    ? contractPolicy(request.contract, ['noul'])
    : { question: ONE_ANSWER_QUESTION, band: ONE_ANSWER_UNSURE_BAND }
}

/** JEV's NOUL question about the person's question: one probability, 0–1. */
export function graphRouteDecisionRequest(request: GraphRouteRequest): DecisionRequest {
  return {
    capability: GRAPH_ROUTE_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { question: request.question },
    questions: { yes: { type: 'noul', instructions: routePolicy(request).question } }
  }
}

/**
 * The `GraphConfig.routeWithJev` of one run: the question is read once and the reading kept, so
 * the run replays the same route. A failure is kept too, with JEV's reason: the full workflow ran.
 */
export function createGraphJevRouter(options: GraphJevOptions & { decide?: typeof jevDecide }) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.route!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`JEV route is not recorded: ${call.id}`)
    }
    const tooLong = graphRouteTooLong(request)
    const result = tooLong
      ? { failed: tooLong }
      : await (options.decide ?? jevDecide)(graphRouteDecisionRequest(request), options)
    const answer = 'failed' in result ? undefined : result.answers.yes
    const reading =
      'failed' in result
        ? { failed: result.failed }
        : answer?.type === 'noul' && Number.isFinite(answer.noul)
          ? { noul: answer.noul }
          : { failed: 'JEV did not answer the question' }
    const markdown = oneAnswerNote(decideOneAnswerRoute(reading, routePolicy(request).band))
    const outcome: GraphOutcome = {
      value:
        'noul' in reading ? { markdown, noul: reading.noul } : { markdown, error: reading.failed }
    }
    options.store.write(call.id, {
      digest,
      outcome,
      ...('failed' in reading ? { detail: reading.failed } : {}),
      at: Date.now()
    })
    if ('failed' in reading) {
      options.log?.(`JEV could not route the question: ${reading.failed}.`)
    }
    return outcome
  }
}

/** One run's router; its ballot file is opened only when the route call actually comes. */
export function graphJevRouterForExecution(
  executionId: string,
  options: Omit<GraphJevOptions, 'store'> = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let router: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    router ??= createGraphJevRouter({ ...options, store: GraphJevStore.forExecution(executionId) })
    return router(call)
  }
}
