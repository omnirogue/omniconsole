/**
 * WHERE a stage runs: a new session, a person, or — WP-4b — the conversation the plan was
 * authored from.
 *
 * The same-conversation route is the narrow one, and every narrowing here is a property the host
 * must be able to honour at launch: the build has to advertise the route, the plan has to HAVE a
 * conversation, one turn belongs to one seat, the agent already in that conversation is the one
 * that answers, and a card-admitted plan already continues a worker of its own. The executor
 * refuses again on the day it runs — a conversation can close between planning and launch — and
 * that refusal is `blocked` with plain words, never a quiet fall back to a new session.
 */

import {
  WORK_PLAN_ROUTES,
  workPlanParallelSeats,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanNode,
  type WorkPlanProblem
} from './work-plan-types'

function block(code: string, nodeId: string, message: string): WorkPlanProblem {
  return { code, nodeId, message, severity: 'block' }
}

function isSolo(plan: WorkPlan, node: WorkPlanNode): boolean {
  return workPlanParallelSeats(plan, node) === 1
}

export function workPlanRouteProblems(
  plan: WorkPlan,
  node: WorkPlanNode,
  ctx: WorkPlanContext
): WorkPlanProblem[] {
  const route = node.route
  if (!route) {
    return []
  }
  if (!(WORK_PLAN_ROUTES as readonly string[]).includes(route)) {
    return [
      block('route-unknown', node.id, `${node.id} asks for a route this build does not know.`)
    ]
  }
  if (node.kind === 'finish') {
    return route === 'human'
      ? []
      : [
          block(
            'route-finish-not-human',
            node.id,
            'A finish either completes on its own or comes back to you; it starts no session.'
          )
        ]
  }
  if (route === 'human') {
    return [
      block(
        'route-human-not-finish',
        node.id,
        `${node.id} hands to a person mid-plan. Put the person at the finish.`
      )
    ]
  }
  if (route !== 'same-session') {
    return []
  }
  if (!ctx.capabilities.sameConversationRoute) {
    return [
      block(
        'route-same-session-unsupported',
        node.id,
        `${node.id} continues this conversation, which this build cannot do yet. It runs as a new agent given the whole conversation.`
      )
    ]
  }
  if (!ctx.source) {
    return [
      block(
        'route-same-session-needs-source',
        node.id,
        `${node.id} continues a conversation, but this plan starts from a fresh prompt.`
      )
    ]
  }
  if (!isSolo(plan, node)) {
    return [
      block(
        'route-same-session-not-solo',
        node.id,
        `${node.id} continues one conversation, so it runs one seat, not several.`
      )
    ]
  }
  // A continued turn is answered by whoever is already IN that conversation. Naming a different
  // agent or model reads as a choice the route cannot honour — the plan would say Claude and the
  // conversation would answer in Codex — so the picker offers none and this refuses one.
  if (
    node.actor.agent !== ctx.source.agent ||
    (node.actor.model && ctx.source.model && node.actor.model !== ctx.source.model)
  ) {
    return [
      block(
        'route-same-session-actor-override',
        node.id,
        `${node.id} continues this conversation, so ${ctx.source.agent} answers it. Remove the other agent, or run this step as a new session.`
      )
    ]
  }
  // A card-admitted plan already has one continuation of its own: the card's worker. Two owners of
  // the same turn is not a thing the host can honour, so the route is local-plan only.
  return ctx.placement === 'card'
    ? [
        block(
          'route-same-session-card-bound',
          node.id,
          `${node.id} continues this conversation, but this plan runs under a card, which continues its own worker.`
        )
      ]
    : []
}
