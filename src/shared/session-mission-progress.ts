import { sessionOutcomeActionKey, sessionOutcomeConditionKey } from './session-outcome-keys'
import type { AgentTodo } from './agent-todo-list'
import { openHumanAttentionRequests } from './session-human-attention'
import type { SessionMission } from './session-mission'
import type {
  SessionOutcomeSet,
  SessionOutcome,
  SessionOutcomeEvidence
} from './session-outcome-types'
import { sessionPullRequestKey, type SessionPullRequestFacts } from './session-pull-request-facts'

export type MissionProgressState =
  | 'not-started'
  | 'working'
  | 'verifying'
  | 'verified'
  | 'blocked'
  | 'rework'
export type MissionProgressItem = SessionMission['deliverables'][number] & {
  basis: 'observed' | 'unconfirmed'
  state: MissionProgressState
  pullRequest: SessionPullRequestFacts | null
  criteria: { id: string; title: string; state: MissionProgressState }[]
  receipts: SessionOutcomeEvidence[]
}
export type MissionAttention = { key: string; owner: 'agent' | 'waiting' | 'you'; text: string }
export type SessionMissionProgress = {
  mission: SessionMission
  items: MissionProgressItem[]
  verified: number
  started: number
  current: { id: string; title: string; activity: string } | null
  attention: MissionAttention[]
  evidence: { pullRequests: number; receipts: number; checksPassing: number }
}

const labelKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** An explicit N/total PR title is a binding only when it also names this mission. */
function stagePullRequest(
  mission: SessionMission,
  ordinal: number,
  prs: readonly SessionPullRequestFacts[]
): SessionPullRequestFacts | null {
  const found = prs.filter((pr) => {
    const match = /^(.+?)\s+(\d+)\/(\d+):/.exec(pr.title)
    return (
      match &&
      Number(match[2]) === ordinal &&
      Number(match[3]) === mission.deliverables.length &&
      labelKey(mission.title).includes(labelKey(match[1]))
    )
  })
  return found.length === 1 ? found[0] : null
}

function stageOutcome(
  item: SessionMission['deliverables'][number],
  pr: SessionPullRequestFacts | null,
  set?: SessionOutcomeSet
): SessionOutcome | null {
  const found =
    set?.outcomes.filter(
      (outcome) =>
        labelKey(outcome.title) === labelKey(item.title) ||
        (pr &&
          outcome.conditions.some(
            (condition) => condition.kind === 'pr' && condition.target === pr.url
          ))
    ) ?? []
  return found.length === 1 ? found[0] : null
}

/** Match current definitions, not an agent's tick or an old outcome status. */
function validReceipts(
  outcome: SessionOutcome,
  pr: SessionPullRequestFacts | null
): SessionOutcomeEvidence[] {
  const pins = pr
    ? outcome.conditions.filter(
        (condition) => ['pr', 'merge'].includes(condition.kind) && condition.target === pr.url
      )
    : []
  // A PR-bound delivery needs a known matching head; an existence receipt is not implementation proof.
  if (
    pr &&
    (pins.length === 0 ||
      pins.some((condition) => !condition.version || condition.version !== pr.headCommit))
  ) {
    return []
  }
  return outcome.evidence.filter(
    (receipt) =>
      receipt.verifier === 'execution-host' &&
      receipt.outcomeId === outcome.id &&
      receipt.outcomeRevision === outcome.revision &&
      outcome.conditions.some(
        (condition) =>
          receipt.conditionId === condition.id &&
          receipt.conditionKey === sessionOutcomeConditionKey(condition) &&
          receipt.kind === condition.kind &&
          receipt.target === condition.target &&
          (condition.version === undefined || receipt.version === condition.version)
      )
  )
}

function outcomeVerified(
  outcome: SessionOutcome,
  receipts: readonly SessionOutcomeEvidence[],
  set: SessionOutcomeSet
): boolean {
  return (
    outcome.conditions.length > 0 &&
    outcome.conditions.every((condition) =>
      receipts.some((receipt) => receipt.conditionId === condition.id)
    ) &&
    (outcome.stepIds ?? []).every((id) => set.completedSteps?.includes(id)) &&
    outcome.actions.every((action) =>
      set.attempts.some(
        (attempt) =>
          attempt.outcomeId === outcome.id &&
          attempt.outcomeRevision === outcome.revision &&
          attempt.actionKey === sessionOutcomeActionKey(action) &&
          attempt.state === 'completed'
      )
    )
  )
}

function todoStage(todo: AgentTodo, mission: SessionMission): string | null {
  const ordinals = [
    ...new Set([...todo.text.slice(0, 2_000).matchAll(/\bPR\s*(\d+)\b/gi)].map((match) => match[1]))
  ]
  if (ordinals.length > 1) {
    return null
  }
  const ordinal = ordinals[0]
  const matches = mission.deliverables.filter((item) =>
    ordinal ? item.ordinal === Number(ordinal) : labelKey(todo.text) === labelKey(item.title)
  )
  return matches.length === 1 ? matches[0].id : null
}

/** Read-only projection of existing facts. No I/O, inference, timers or stored completion flags. */
export function sessionMissionProgress(input: {
  mission: SessionMission
  outcomes?: SessionOutcomeSet
  pullRequests: readonly SessionPullRequestFacts[]
  todos: readonly AgentTodo[]
  working: boolean
  planVersion?: number
  activity?: string
}): SessionMissionProgress {
  const { mission, outcomes: set, pullRequests: prs, todos, working } = input
  const currentTodo = todos.find((todo) => todo.status === 'current')
  const activityId = input.activity
    ? todoStage({ text: input.activity, status: 'current' }, mission)
    : null
  const currentId = working
    ? (activityId ?? (currentTodo ? todoStage(currentTodo, mission) : null))
    : null
  const attention: MissionAttention[] = []
  const items = mission.deliverables.map((item): MissionProgressItem => {
    const pr = stagePullRequest(mission, item.ordinal, prs)
    const outcome = stageOutcome(item, pr, set)
    const receipts = outcome ? validReceipts(outcome, pr) : []
    const claimed = todos.some(
      (todo) => todoStage(todo, mission) === item.id && todo.status === 'completed'
    )
    let state: MissionProgressState = pr || claimed ? 'verifying' : 'not-started'
    if (outcome && set) {
      if (outcomeVerified(outcome, receipts, set)) {
        state = 'verified'
      } else if (outcome.status === 'blocked') {
        state = outcome.block?.class === 'recovering' ? 'rework' : 'blocked'
      } else if (outcome.status === 'running') {
        state = working ? 'working' : 'verifying'
      } else if (receipts.length > 0) {
        state = 'verifying'
      }
      if (outcome.status === 'blocked' && outcome.block?.class !== 'attention') {
        attention.push({
          key: outcome.id,
          owner: outcome.block?.class === 'waiting' ? 'waiting' : 'agent',
          text: outcome.blockedReason ?? outcome.block?.wake ?? outcome.title
        })
      }
    }
    if (currentId === item.id && working && !['verified', 'blocked', 'rework'].includes(state)) {
      state = 'working'
    }
    if (
      pr?.checks === 'failure' ||
      pr?.reviewDecision === 'changes-requested' ||
      pr?.state === 'closed'
    ) {
      state = 'rework'
      attention.push({
        key: sessionPullRequestKey(pr),
        owner: 'agent',
        text: `#${pr.number} ${pr.state === 'closed' ? 'closed without merge' : pr.reviewDecision === 'changes-requested' ? 'changes requested' : 'checks failing'}`
      })
    }
    if (pr?.reviewDecision === 'review-required' && pr.checks === 'success') {
      attention.push({
        key: `review:${sessionPullRequestKey(pr)}`,
        owner: 'waiting',
        text: `#${pr.number} review pending`
      })
    }
    return {
      ...item,
      state,
      basis: pr || outcome || claimed || currentId === item.id ? 'observed' : 'unconfirmed',
      pullRequest: pr,
      receipts,
      criteria:
        outcome?.conditions.map((condition) => ({
          id: condition.id,
          title: condition.label ?? condition.target,
          state: receipts.some((receipt) => receipt.conditionId === condition.id)
            ? 'verified'
            : outcome.status === 'pending'
              ? 'not-started'
              : 'verifying'
        })) ?? []
    }
  })
  for (const request of set ? openHumanAttentionRequests(set, input.planVersion) : []) {
    attention.push({
      key: request.id,
      owner: request.recipient.type === 'owner' ? 'you' : 'waiting',
      text: request.ask
    })
  }
  const current =
    items.find((item) => item.id === currentId) ?? items.find((item) => item.state === 'working')
  const boundPrs = items.flatMap((item) => (item.pullRequest ? [item.pullRequest] : []))
  return {
    mission,
    items,
    verified: items.filter((item) => item.state === 'verified').length,
    started: items.filter((item) => item.state !== 'not-started').length,
    current: current
      ? {
          id: current.id,
          title: current.title,
          activity:
            activityId === current.id ? input.activity! : (currentTodo?.text ?? current.title)
        }
      : working && input.activity
        ? { id: '', title: 'Latest agent update', activity: input.activity.slice(0, 300) }
        : null,
    attention,
    evidence: {
      pullRequests: boundPrs.length,
      receipts: items.reduce((count, item) => count + item.receipts.length, 0),
      checksPassing: boundPrs.filter((pr) => pr.checks === 'success').length
    }
  }
}
