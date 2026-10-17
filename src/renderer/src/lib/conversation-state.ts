import type { SessionChain } from '../../../shared/session-chain-types'
import { sessionOutcomePlanState } from '../../../shared/session-outcome-plan-state'
import { workPlanNotation } from '../../../shared/work-plan-notation'
import type { AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import { currentPlanAttempts, sessionRunRowState } from './session-run-row-state'

export { currentPlanAttempts } from './session-run-row-state'

/**
 * A conversation's state as a person reads it: what it means for their attention,
 * not which hook fired. ❗ Needs you always outranks work in progress; waiting sits last.
 */
export type ConversationState =
  | 'running'
  | 'queued'
  | 'recovering'
  | 'awaiting'
  | 'plan-ready'
  | 'needs-you'
  | 'working'
  | 'active'
  | 'done'
  | 'failed'
  | 'waiting'
  | 'none'
  | 'inactive'
  | 'unverifiable'
  | 'interrupted'

export function conversationState(input: {
  state: AgentDotState | null | undefined
  /** A live pane's own question. A plan row ignores it: its requests are the run's, not a pane's. */
  needsYou: boolean
  waiting: boolean
  chain?: SessionChain | null
  now?: number
}): ConversationState {
  if (input.waiting) {
    return 'waiting'
  }
  // Why: a cancelled plan gives the conversation back; it reads as the ordinary conversation it is.
  if (input.chain?.outcomeSet && input.chain.state !== 'cancelled') {
    return pursuitConversationState(input.chain, input.now ?? Date.now())
  }
  if (input.needsYou) {
    return 'needs-you'
  }
  switch (input.state) {
    case 'working':
      return 'working'
    case 'monitoring':
      return 'awaiting'
    case 'blocked':
    case 'waiting':
    case 'permission':
      return 'needs-you'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    case 'idle':
      return 'inactive'
    case null:
    case undefined:
      return 'none'
  }
}

/** Lower sorts first: what needs a person, then what is moving, then the rest. */
export function conversationStateRank(state: ConversationState): number {
  switch (state) {
    case 'needs-you':
      return 0
    case 'running':
    case 'working':
      return 1
    case 'queued':
    case 'awaiting':
      return 2
    case 'recovering':
      return 2.5
    case 'plan-ready':
      return 3.5
    case 'inactive':
    case 'active':
      return 2
    case 'unverifiable':
    case 'interrupted':
    case 'failed':
      return 3
    case 'done':
      return 4
    case 'none':
      return 5
    case 'waiting':
      return 6
  }
}

/** The hover text: one plain sentence per state. */
export function conversationStateLabel(state: ConversationState): string {
  switch (state) {
    case 'running':
      return translate('workPlan.running', 'Running')
    case 'queued':
      return translate('workPlan.queued', 'Queued')
    case 'recovering':
      return translate(
        'conversations.stateRecovering',
        'Recovering — the host is retrying by itself; nothing is needed from you.'
      )
    case 'awaiting':
      return translate(
        'conversations.stateAwaiting',
        'Waiting — for evidence or someone else; nothing is needed from you.'
      )
    case 'plan-ready':
      return translate('workPlan.ready', 'Plan ✓')
    case 'needs-you':
      return translate(
        'conversations.stateNeedsYou',
        'Needs you — waiting for your answer or approval.'
      )
    case 'working':
      return translate('conversations.stateWorking', 'Working — the agent is busy right now.')
    case 'active':
      return translate(
        'conversations.stateActive',
        'Active — open and idle; nothing is waiting on you.'
      )
    case 'inactive':
      return translate('conversations.stateInactive', 'Inactive — no agent is executing.')
    case 'unverifiable':
      return translate(
        'conversations.stateUnverifiable',
        'Unverified — no current execution evidence.'
      )
    case 'interrupted':
      return translate('conversations.stateInterrupted', 'Interrupted — the work was stopped.')
    case 'done':
      return translate(
        'conversations.stateDone',
        'Done — the turn finished. Verified complete only when its plan proves it.'
      )
    case 'failed':
      return translate(
        'conversations.stateFailed',
        'Stopped — the agent failed or was interrupted.'
      )
    case 'waiting':
      return translate('conversations.stateWaiting', 'Snoozed — hidden until it returns.')
    case 'none':
      return translate('conversations.stateNone', 'Conversation — no agent is reporting here.')
  }
}

const DEFAULT_TERMINAL_TITLE_RE = /^terminal \d+$/i

/** A name a person can read: never "Terminal 3". */
export function isPlaceholderConversationTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? ''
  return trimmed.length === 0 || DEFAULT_TERMINAL_TITLE_RE.test(trimmed)
}

export function fallbackConversationTitle(agentLabel: string): string {
  return translate('conversations.untitled', '{{agent}} conversation', { agent: agentLabel })
}

/** A conversation is named by what it is about; "Terminal 3" is not a name. */
export function readableConversationLabel(label: string | undefined, agent: string): string {
  return isPlaceholderConversationTitle(label)
    ? fallbackConversationTitle(agent)
    : (label as string)
}

export function conversationGroupLabel(
  kind: 'drafts' | 'waiting' | 'completed' | 'archived' | 'hidden' | 'stopped' | 'workers',
  count: number
): string {
  switch (kind) {
    case 'drafts':
      return translate('conversations.draftsGroup', 'Drafts ({{count}})', { count })
    case 'waiting':
      return translate('conversations.waitingGroup', 'Waiting ({{count}})', { count })
    case 'stopped':
      return translate('conversations.stoppedGroup', 'Stopped ({{count}})', { count })
    case 'completed':
      return translate('conversations.doneGroup', 'Done ({{count}})', { count })
    case 'archived':
      return translate('conversations.archivedGroup', 'Archived ({{count}})', { count })
    case 'hidden':
      return translate('conversations.hiddenCount', 'Hidden ({{count}})', { count })
    case 'workers':
      return translate('conversations.agentSessionsGroup', 'Agent sessions ({{count}})', {
        count
      })
  }
}

/** The run policy's phase as the row glyph reads it; nothing here decides "needs you". */
function pursuitConversationState(chain: SessionChain, now: number): ConversationState {
  const run = sessionRunRowState(chain, { now })
  switch (run.phase) {
    case 'needs-you':
      return 'needs-you'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'none'
    case 'recovering':
      return 'recovering'
    case 'waiting':
      return 'awaiting'
    case 'active':
      if (run.running) {
        return 'running'
      }
      return sessionOutcomePlanState(chain) === 'plan-ready' ? 'plan-ready' : 'queued'
  }
}

export function conversationPlanProgress(chain: SessionChain) {
  const outcomes = chain.outcomeSet?.outcomes ?? []
  const conditions = outcomes.flatMap((outcome) =>
    outcome.conditions.map((condition) => ({
      satisfied: outcome.evidence.some(
        (receipt) =>
          receipt.outcomeId === outcome.id &&
          receipt.conditionId === condition.id &&
          receipt.outcomeRevision === outcome.revision
      )
    }))
  )
  const steps = chain.steps.filter(
    (step) => (step.kind === 'handoff' ? 1 : (step.planVersion ?? 1)) === (chain.planVersion ?? 1)
  )
  const stages = new Map<string, typeof steps>()
  for (const step of steps) {
    const key = (step.kind === 'handoff' ? undefined : step.planNodeId) ?? step.id
    stages.set(key, [...(stages.get(key) ?? []), step])
  }
  const completed = new Set(chain.outcomeSet?.completedSteps ?? [])
  const index = [...stages.values()].findIndex((seats) =>
    seats.some((step) => !completed.has(step.id))
  )
  return {
    satisfied: conditions.filter((condition) => condition.satisfied).length,
    total: conditions.length,
    stage: index === -1 ? stages.size : index + 1,
    stages: stages.size,
    running: currentPlanAttempts(chain).filter((attempt) => attempt.state === 'running').length
  }
}

export function conversationPlanLabel(chain: SessionChain): string {
  const progress = conversationPlanProgress(chain)
  const notation = workPlanNotation(chain)
  const summary = translate(
    'workPlan.progress',
    '{{satisfied}}/{{total}} done-when · stage {{stage}}/{{stages}}',
    progress
  )
  const version = chain.planVersion ?? 1
  const history = chain.planVersions?.find((entry) => entry.version === version)
  const versionLabel =
    version > 1
      ? translate('workPlan.version', 'Plan v{{version}} · v{{previous}} superseded: {{reason}}', {
          version,
          previous: history?.supersedes ?? version - 1,
          reason: history?.reason ?? ''
        })
      : ''
  return [versionLabel, notation, summary].filter(Boolean).join(' · ')
}
