import { translate } from '@/i18n/i18n'
import { agentTodoProgress, type AgentTodo } from '../../../../shared/agent-todo-list'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import type { SessionChain } from '../../../../shared/session-chain-types'
import { sessionChainStepLine, sessionChainStepPlace } from './session-activity-step'
import type { SessionChainStepPlace } from './session-activity-step'
import { activityAgeLabel, stripInlineMarkdown } from './session-activity-text'
import { plainToolActivity } from './session-activity-tool-words'
import { backgroundWorkLine } from '@/lib/background-work-wording'

/** Which real signal produced the headline. Never a guess: `unknown` means nothing is known. */
export type SessionActivitySignal = 'chain' | 'todos' | 'activity' | 'unknown'

/** The hook fields this summary reads. A narrow pick so a row can subscribe to just these. */
export type SessionActivityStatus = Pick<
  AgentStatusEntry,
  'state' | 'stateStartedAt' | 'toolName' | 'toolInput' | 'lastAssistantMessage'
> &
  Partial<
    Pick<
      AgentStatusEntry,
      | 'workingMode'
      | 'backgroundTaskCount'
      | 'interrupted'
      | 'lastAssistantMessageIsToolOutput'
      | 'lastCompletedAssistantMessage'
    >
  >

export type SessionActivityState = {
  state: AgentStatusState
  /** "Working", "Waiting for you", … */
  label: string
  /** "Working · 3 min ago"; falls back to the bare label when the start time is unknown. */
  line: string
  /** When this state began (epoch ms), for the absolute time in a title; null when unknown. */
  at: number | null
}

export type SessionActivitySummary = {
  signal: SessionActivitySignal
  /** One short line. Safe for a sidebar row: single line, whitespace collapsed, bounded. */
  line: string
  /** The line is the agent's own last words — which a transcript right below shows in full. */
  quotesAgent: boolean
  /** Second line for the details surface; null when it would only repeat `line`. */
  detail: string | null
  /** The literal tool call behind a plain-words `line`, for a hover; absent otherwise. */
  full?: string
  state: SessionActivityState | null
  step: SessionChainStepPlace | null
  todos: readonly AgentTodo[]
}

export type SessionActivityInputs = {
  /** The plan that launched this pane, when one did. */
  chain?: SessionChain | null
  paneKey?: string | null
  status?: SessionActivityStatus | null
  /** Todos the agent published in its transcript; empty when it published none. */
  todos?: readonly AgentTodo[]
  now: number
}

/** Bounds the headline so a row can never be pushed around by a long tool input. */
export const SESSION_ACTIVITY_LINE_MAX = 90

export function trimActivityText(text: string, max = SESSION_ACTIVITY_LINE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function stateLabel(status: SessionActivityStatus): string {
  switch (status.state) {
    case 'working':
      return status.workingMode === 'monitoring'
        ? backgroundWorkLine(status.backgroundTaskCount)
        : translate('sessionActivity.stateWorking', 'Working')
    case 'waiting':
      return translate('sessionActivity.stateWaiting', 'Waiting for you')
    case 'blocked':
      return translate('sessionActivity.stateBlocked', 'Blocked on a decision')
    case 'done':
      return status.interrupted === true
        ? translate('sessionActivity.stateInterrupted', 'Interrupted')
        : translate('sessionActivity.stateDone', 'Finished its turn')
  }
}

function describeState(status: SessionActivityStatus, now: number): SessionActivityState {
  const label = stateLabel(status)
  const started = status.stateStartedAt
  const at = Number.isFinite(started) && started > 0 && started <= now ? started : null
  return {
    state: status.state,
    label,
    line:
      at === null
        ? label
        : translate('sessionActivity.stateAt', '{{state}} · {{when}}', {
            state: label,
            when: activityAgeLabel(at, now)
          }),
    at
  }
}

type CurrentActivity = { line: string; quotesAgent: boolean; full?: string }

/** The most recent meaningful thing the pane did: the running tool, else the last turn's prose. */
function describeCurrentActivity(status: SessionActivityStatus): CurrentActivity | null {
  const tool = status.toolName?.trim()
  if (tool && status.state === 'working') {
    const input = status.toolInput?.trim()
    const literal = input
      ? translate('sessionActivity.toolRun', '{{tool}} · {{input}}', { tool, input })
      : translate('sessionActivity.toolRunBare', 'Running {{tool}}', { tool })
    const plain = plainToolActivity(tool, input)
    return plain
      ? { line: trimActivityText(plain), quotesAgent: false, full: trimActivityText(literal, 400) }
      : { line: trimActivityText(literal), quotesAgent: false }
  }
  // Why the tool-output guard: a tool's stdout is not the agent saying anything.
  const said =
    (status.lastAssistantMessageIsToolOutput === true ? '' : status.lastAssistantMessage?.trim()) ||
    status.lastCompletedAssistantMessage?.trim() ||
    ''
  const flat = trimActivityText(stripInlineMarkdown(said))
  if (flat) {
    return { line: flat, quotesAgent: true }
  }
  return tool
    ? {
        line: trimActivityText(
          translate('sessionActivity.toolRunBare', 'Running {{tool}}', { tool })
        ),
        quotesAgent: false
      }
    : null
}

/** The transcript's latest assistant prose as this preview would print it, or null. */
export function activityPreviewOf(text: string | null | undefined): string | null {
  return text ? trimActivityText(stripInlineMarkdown(text)) || null : null
}

function todoLine(todos: readonly AgentTodo[]): string | null {
  const progress = agentTodoProgress(todos)
  if (progress.total === 0) {
    return null
  }
  return trimActivityText(
    progress.current
      ? translate('sessionActivity.todoCurrent', '{{done}}/{{total}} · {{task}}', {
          done: progress.completed,
          total: progress.total,
          task: progress.current.text
        })
      : translate('sessionActivity.todoAllDone', 'All {{total}} tasks done', {
          total: progress.total
        })
  )
}

/**
 * What a session is doing, from the signals that actually exist: the plan step that
 * launched it, the task list it published, else its live hook activity. Nothing is
 * inferred — with no signal the summary says so, so a surface never shows invented
 * progress or an empty line.
 */
export function describeSessionActivity(inputs: SessionActivityInputs): SessionActivitySummary {
  const status = inputs.status ?? null
  const todos = inputs.todos ?? []
  const step = inputs.chain ? sessionChainStepPlace(inputs.chain, inputs.paneKey ?? null) : null
  const state = status ? describeState(status, inputs.now) : null
  const activity = status ? describeCurrentActivity(status) : null
  const todoHeadline = todoLine(todos)
  const quiet = { quotesAgent: false, state, step: null, todos }
  if (step) {
    return {
      ...quiet,
      signal: 'chain',
      line: trimActivityText(sessionChainStepLine(step)),
      detail: todoHeadline ?? activity?.line ?? null,
      step
    }
  }
  if (todoHeadline) {
    return { ...quiet, signal: 'todos', line: todoHeadline, detail: activity?.line ?? null }
  }
  if (activity) {
    return {
      ...quiet,
      signal: 'activity',
      line: activity.line,
      quotesAgent: activity.quotesAgent,
      detail: null,
      ...(activity.full ? { full: activity.full } : {})
    }
  }
  if (state) {
    return { ...quiet, signal: 'activity', line: state.label, detail: null }
  }
  return {
    ...quiet,
    signal: 'unknown',
    line: translate('sessionActivity.unknown', 'Status unknown'),
    detail: null,
    state: null
  }
}

/**
 * The same derivation with the wall clock read for you. Why a projection and not a hook
 * argument: the clock is not a render input — the existing `agentStatusEpoch` tick is what
 * refreshes the wording, exactly as `selectAgentPaneSnapshot` reads `Date.now()` itself.
 */
export function selectSessionActivity(
  inputs: Omit<SessionActivityInputs, 'now'>
): SessionActivitySummary {
  return describeSessionActivity({ ...inputs, now: Date.now() })
}

/**
 * Whether a sidebar row shows this line. A plan step or a task list is worth a row line
 * whatever the pane is doing; bare activity is not once the turn is over, because a
 * finished row already says so — and "status unknown" on every dormant row would be noise,
 * not information. The details surface has no such filter: it always says what it knows.
 */
export function showsSessionActivityOnRow(summary: SessionActivitySummary): boolean {
  if (summary.signal === 'chain' || summary.signal === 'todos') {
    return true
  }
  return summary.signal === 'activity' && summary.state?.state !== 'done'
}
