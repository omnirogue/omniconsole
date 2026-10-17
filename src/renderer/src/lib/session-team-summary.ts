import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SessionActionPresetId } from '../../../shared/session-action-presets'
import type { ConsoleWorkflowNode } from '../../../shared/console-workflow-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  outcomeChainCapacityLabel,
  outcomeChainCardBound,
  OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_DEFAULT
} from '../../../shared/outcome-chain-concurrency'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep
} from '../../../shared/session-chain-types'
import { assignStepsToNodes, nodeStageKey, workflowNumber } from './session-team-seat-matching'
import { completedActionStageKeys } from './session-team-stage-actions'

export type SessionTeamRole =
  | 'producer'
  | 'worker'
  | 'reviewer'
  | 'repair'
  | 'subagent'
  | 'coordinator'

export type SessionTeamMember = {
  key: string
  agent: string | null
  model: string | null
  effort: string | null
  role: SessionTeamRole
  /**
   * `planned` has not launched yet; `skipped`, `cancelled` and `failed` will never run; the
   * rest mirror the live agent's own state.
   */
  state:
    | 'planned'
    | 'working'
    | 'blocked'
    | 'waiting'
    | 'done'
    | 'idle'
    | 'skipped'
    | 'cancelled'
    | 'failed'
  label: string | null
  group: string | null
  round: { index: number; total: number } | null
  /** `local`, `ssh:<target>`, `runtime:<id>`, `fleet` or `fleet:<machine>`. */
  placement: string | null
  /** The plan action the seat performs (improve, review, …); absent when the seat has none. */
  action?: SessionActionPresetId | null
}

/** What this chain may run at once, and how that reads: an admitted card chain is never parallel. */
export type SessionTeamCapacity = { limit: number; cardBound: boolean; label: string }

export type SessionTeamSummary = {
  members: SessionTeamMember[]
  plannedCount: number
  liveCount: number
  /** Seats of the current plan version running RIGHT NOW — not groups the plan authored. */
  runningSeats: number
  capacity: SessionTeamCapacity
  parallelGroups: number
  sequentialCount: number
  reviewerSeats: number
  maxRounds: number | null
  placements: string[]
}

/** None of these is future work, so none counts as planned or live. */
const OFF_PLAN_STATES = new Set<SessionTeamMember['state']>(['skipped', 'cancelled', 'failed'])

/** The steps the plan durably recorded as finished, whatever their own row still says. */
function chainCompletedStepIds(chain: SessionChain | null): ReadonlySet<string> {
  return new Set(chain?.outcomeSet?.completedSteps ?? [])
}

function nodeRole(node: ConsoleWorkflowNode): SessionTeamRole {
  const role = node.loop_stage?.role
  if (role === 'producer') {
    return 'producer'
  }
  if (role === 'participant' || role === 'reviewer') {
    return 'reviewer'
  }
  if (role === 'repair') {
    return 'repair'
  }
  return 'worker'
}

function chainPlacement(chain: SessionChain | null): string | null {
  const hostId = chain?.placement ?? chain?.hostId ?? null
  const parsed = parseExecutionHostId(hostId)
  return parsed ? (parsed.kind === 'local' ? 'local' : hostId) : null
}

/** Panes the plan's agent steps launched, so their live rows can be read. */
export function chainLaunchedPaneKeys(chain: SessionChain | null): string[] {
  return (chain?.steps ?? []).flatMap((step) =>
    isSessionChainAgentStep(step) && step.launchedPaneKey ? [step.launchedPaneKey] : []
  )
}

/** A launched step is under way even before its pane reports; only an unlaunched one is planned. */
function memberState(
  step: SessionChainAgentStep | null | undefined,
  live: AgentStatusEntry | undefined,
  chain: SessionChain | null,
  completed: ReadonlySet<string>,
  stageDone = false
): SessionTeamMember['state'] {
  // Why: the plan's durable record outranks a retained pane row that never learnt the step ended,
  // and it is the only record a stage whose work ran as outcome actions leaves behind.
  if (step ? completed.has(step.id) : stageDone) {
    return 'done'
  }
  if (live) {
    return live.state
  }
  if (step?.status === 'skipped') {
    return 'skipped'
  }
  // Why: a plan that stopped never runs what it left behind, so planned would promise future work.
  if (chain?.state === 'cancelled') {
    return 'cancelled'
  }
  if (chain?.state === 'failed') {
    return 'failed'
  }
  if (chain?.state === 'done') {
    return 'skipped'
  }
  return step?.status === 'launched' ? 'waiting' : 'planned'
}

function membersFromGraph(
  nodes: readonly ConsoleWorkflowNode[],
  chain: SessionChain | null,
  byPane: ReadonlyMap<string, AgentStatusEntry>,
  completed: ReadonlySet<string>,
  doneStageKeys: ReadonlySet<string>
): { members: SessionTeamMember[]; usedStepIds: Set<string> } {
  const agentNodes = nodes.filter((node) => node.actor_type === 'ai')
  const seatByNode = assignStepsToNodes(agentNodes, chain)
  const usedStepIds = new Set([...seatByNode.values()].map((seat) => seat.step.id))
  const members = agentNodes.map((node, index) => {
    const round = workflowNumber(node.loop_stage?.round)
    const total = workflowNumber(node.loop_stage?.max_rounds)
    const seat = seatByNode.get(index)
    const step = seat?.step
    const live = step?.launchedPaneKey ? byPane.get(step.launchedPaneKey) : undefined
    return {
      key: `graph:${node.key}`,
      agent: live?.agentType ?? node.agent ?? node.provider ?? null,
      model: live?.model ?? node.model ?? null,
      effort: node.effort ?? null,
      role: nodeRole(node),
      state: memberState(step, live, chain, completed, doneStageKeys.has(nodeStageKey(node))),
      // Why: interchangeable seats have no join key, so a title here would name the wrong agent.
      label: seat?.ambiguous ? null : node.title,
      group: node.parallel_group ?? null,
      round: round === null ? null : { index: round, total: total ?? round },
      placement:
        node.placement === 'fleet'
          ? node.machine
            ? `fleet:${node.machine}`
            : 'fleet'
          : (node.placement ?? null)
    }
  })
  return { members, usedStepIds }
}

function stepRole(step: SessionChainAgentStep): SessionTeamRole {
  return step.review ? 'reviewer' : step.reviewRepair ? 'repair' : 'worker'
}

function membersFromChain(
  chain: SessionChain,
  byPane: ReadonlyMap<string, AgentStatusEntry>,
  completed: ReadonlySet<string>,
  skipStepIds: ReadonlySet<string> = new Set()
) {
  const placement = chainPlacement(chain)
  const planVersion = chain.planVersion ?? 1
  return chain.steps
    .filter(isSessionChainAgentStep)
    // A seat a newer plan version replaced is history, not a team member who is about to work.
    .filter((step) => (step.planVersion ?? 1) >= planVersion)
    .filter((step) => !skipStepIds.has(step.id))
    .map((step): SessionTeamMember => {
      const live = step.launchedPaneKey ? byPane.get(step.launchedPaneKey) : undefined
      return {
        key: `step:${step.id}`,
        agent: live?.agentType ?? step.agent,
        model: live?.model ?? step.model ?? null,
        effort: step.effort ?? null,
        role: stepRole(step),
        state: memberState(step, live, chain, completed),
        label: null,
        group: step.group ?? null,
        round: step.round
          ? { index: step.round.index, total: step.round.total }
          : step.review
            ? { index: step.review.round, total: step.review.maxRounds }
            : null,
        placement,
        action: step.presetId ?? null
      }
    })
}

export type SessionTeamInput = {
  paneKey: string | null
  entry: AgentStatusEntry | null
  /** Agents dispatched by this pane (their `orchestration.parentPaneKey` is this pane). */
  orchestrationChildren: readonly AgentStatusEntry[]
  chain: SessionChain | null
  /** Resolves a launched step's pane to its live status row. */
  statusByPaneKey?: ReadonlyMap<string, AgentStatusEntry>
  /** The person's concurrency setting, already clamped. Absent means the default. */
  maxConcurrentAgents?: number
}

export function buildSessionTeamSummary(input: SessionTeamInput): SessionTeamSummary {
  const byPane = input.statusByPaneKey ?? new Map<string, AgentStatusEntry>()
  const nodes = input.chain?.outcomeSet?.workflow?.preview.graph.nodes ?? []
  const completed = chainCompletedStepIds(input.chain)
  const doneStages = completedActionStageKeys(input.chain)
  const graph =
    nodes.length > 0 ? membersFromGraph(nodes, input.chain, byPane, completed, doneStages) : null
  // Why: steps the graph does not describe (an amendment's reviewers) still belong to the team.
  const planned = graph
    ? [...graph.members, ...membersFromChain(input.chain!, byPane, completed, graph.usedStepIds)]
    : input.chain
      ? membersFromChain(input.chain, byPane, completed)
      : []
  const workers = input.orchestrationChildren.map((child): SessionTeamMember => ({
    key: `pane:${child.paneKey}`,
    agent: child.agentType ?? null,
    model: child.model ?? null,
    effort: null,
    role: 'worker',
    state: child.state,
    label: child.orchestration?.displayName ?? child.orchestration?.taskTitle ?? null,
    group: null,
    round: null,
    placement: null
  }))
  const subagents = (input.entry?.subagents ?? []).map((subagent): SessionTeamMember => ({
    key: `subagent:${subagent.id}`,
    agent: subagent.agentType ?? null,
    model: subagent.model ?? null,
    effort: null,
    role: 'subagent',
    state: subagent.state,
    label: subagent.description ?? null,
    group: null,
    round: null,
    placement: null
  }))
  const members = [...planned, ...workers, ...subagents]
  const groups = new Set(members.flatMap((member) => (member.group ? [member.group] : [])))
  const reviewers = members.filter((member) => member.role === 'reviewer')
  const totals = members.flatMap((member) => (member.round ? [member.round.total] : []))
  const live = (member: SessionTeamMember): boolean =>
    member.state !== 'planned' && member.state !== 'done' && !OFF_PLAN_STATES.has(member.state)
  const cardBound = outcomeChainCardBound(input.chain?.outcomeSet?.continuation)
  const limit = cardBound
    ? 1
    : (input.maxConcurrentAgents ?? OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_DEFAULT)
  return {
    members,
    plannedCount: members.filter((member) => member.state === 'planned').length,
    liveCount: members.filter(live).length,
    runningSeats: planned.filter(live).length,
    capacity: { limit, cardBound, label: outcomeChainCapacityLabel(limit, cardBound) },
    parallelGroups: groups.size,
    sequentialCount: planned.filter((member) => !member.group).length,
    reviewerSeats: new Set(reviewers.map((member) => `${member.agent}|${member.model}`)).size,
    maxRounds: totals.length > 0 ? Math.max(...totals) : null,
    placements: [
      ...new Set(members.flatMap((member) => (member.placement ? [member.placement] : [])))
    ]
  }
}
