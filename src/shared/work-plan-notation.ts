import type { SessionChain } from './session-chain-types'
import type { WorkPlanRuntimeStep } from './work-plan-runtime-adapter'
import {
  workPlanNodeGroup,
  workPlanNodeSeatCount,
  type WorkPlan,
  type WorkPlanRole
} from './work-plan-types'
import { compileWorkPlanExecution, type WorkPlanCompileContext } from './work-plan-compile'
import { sessionOutcomeStageCount } from './session-outcome-validation'

const GLYPHS: Partial<Record<WorkPlanRole, string>> = {
  synthesize: '◇',
  judge: '⚖',
  improve: '✨',
  verify: '✓',
  plan: '📝'
}
function label(role: string): string {
  return GLYPHS[role as WorkPlanRole] ?? role.charAt(0).toUpperCase() + role.slice(1)
}

export function workPlanNotation(input: WorkPlan | SessionChain): string {
  const stages: { key?: string; text: string; seats: number }[] = []
  let finish = false
  if ('nodes' in input) {
    for (const node of input.nodes) {
      if (node.kind === 'finish') {
        finish = node.how === 'my-review'
        continue
      }
      const key = workPlanNodeGroup(node)
      const previous = stages.at(-1)
      if (key && previous?.key === key) {
        previous.seats += workPlanNodeSeatCount(node)
      } else {
        stages.push({
          key,
          seats: node.kind === 'review' ? 1 : workPlanNodeSeatCount(node),
          text: node.kind === 'review' ? '🔁' : label(node.role)
        })
      }
    }
  } else {
    const version = input.planVersion ?? 1
    for (const step of input.steps) {
      if (step.kind === 'handoff') {
        finish = true
        continue
      }
      if (((step as WorkPlanRuntimeStep).planVersion ?? 1) !== version) {
        continue
      }
      if (step.reviewRepair || (step.review?.round ?? 1) > 1) {
        continue
      }
      const key = step.review?.groupId ?? step.group
      const previous = stages.at(-1)
      if (key && previous?.key === key) {
        if (!step.review) {
          previous.seats++
        }
      } else {
        stages.push({ key, seats: 1, text: step.review ? '🔁' : label(step.presetId ?? 'work') })
      }
    }
    finish ||= input.end === 'me'
  }
  const notation = [
    ...stages.map((s) => `${s.seats > 1 ? `⑂${s.seats} ` : ''}${s.text}`),
    ...(finish ? ['👤'] : [])
  ].join(' → ')
  const version = 'nodes' in input ? 1 : (input.planVersion ?? 1)
  return version > 1
    ? `${Array.from({ length: version - 1 }, (_, i) => `v${i + 1} ✗ superseded`).join(' · ')} · v${version} ${notation}`
    : notation
}

export function workPlanSummary(
  plan: WorkPlan,
  capacity: number
): {
  executions: number
  stages: number
  maxConcurrency: number
  queued: number
  newSessions: number
  continued: number
} {
  const ctx: WorkPlanCompileContext = {
    usableAgents: [],
    source: { agent: 'claude' },
    placement: 'local',
    accountCatalogue: [],
    commitSource: 'user',
    capabilities: { sameConversationRoute: true }
  }
  // Counting shares the runtime compiler, including explicit repairs and folded review rounds.
  const compiled = compileWorkPlanExecution(plan, ctx)
  const executions = compiled.steps.length
  const definition = compiled.outcomes[0]
  const stages = definition ? sessionOutcomeStageCount(definition, compiled.steps) : 0
  const groups = new Map<string, number>()
  for (const step of compiled.steps) {
    groups.set(step.group ?? step.id, (groups.get(step.group ?? step.id) ?? 0) + 1)
  }
  const width = Math.max(0, ...groups.values())
  const limit = Number.isFinite(capacity) ? Math.max(1, Math.trunc(capacity)) : 1
  const continued = compiled.steps.filter((step) => step.route === 'same-session').length
  return {
    executions,
    stages,
    maxConcurrency: Math.min(width, limit),
    queued: Math.max(0, width - limit),
    newSessions: executions - continued,
    continued
  }
}
