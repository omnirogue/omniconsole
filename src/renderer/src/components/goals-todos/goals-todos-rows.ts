import { agentTodoProgress, type AgentTodo } from '../../../../shared/agent-todo-list'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { SessionGoal } from '../../../../shared/session-goal'
import type { SessionCompactContext } from '../../../../shared/session-compact-context'
import type { SessionPullRequestMention } from '../../../../shared/session-pull-request-refs'
import type { SessionTodoSource } from '../../../../shared/session-todo-list'
import type { SidebarSession } from '@/lib/sidebar-sessions'

/** Scan bound: at most this many sessions are read, newest first. */
export const GOALS_TODOS_MAX_SESSIONS = 100
/** Finished sessions older than this are left out; a session still going always shows. */
export const GOALS_TODOS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** The finished group is a recent list, not an archive. */
export const GOALS_TODOS_IDLE_SHOWN = 20

export type GoalsTodosGroupKind = 'needs-you' | 'in-progress' | 'idle'

/** The live hook facts a row needs; null when the session has no live status. */
export type GoalsTodosStatus = { state: AgentStatusState; updatedAt: number }

/** What was read from the session's own transcript. */
export type GoalsTodosDetails = {
  context?: SessionCompactContext
  goal: SessionGoal | null
  todos: readonly AgentTodo[]
  source: SessionTodoSource
  /** Newest message time in the transcript window, epoch ms. */
  lastMessageAt: number | null
  /** Pull requests the AI named in that window, for the row's progress mark. */
  pullRequests?: readonly SessionPullRequestMention[]
}

export type GoalsTodosInput = {
  session: SidebarSession
  status: GoalsTodosStatus | null
  /** When the session last did anything the app recorded, from its hook or saved record. */
  updatedAt: number | null
}

export type GoalsTodosRow = {
  key: string
  session: SidebarSession
  group: GoalsTodosGroupKind
  heading: string
  /** The first prompt; its full text backs the hover and the expanded view. */
  goal: SessionGoal | null
  /** The goal line under the heading; null when the heading already says it. */
  goalLine: string | null
  todos: readonly AgentTodo[]
  source: SessionTodoSource
  completed: number
  total: number
  current: AgentTodo | null
  updatedAt: number | null
}

export type GoalsTodosGroups = Record<GoalsTodosGroupKind, GoalsTodosRow[]> & {
  /** Finished sessions beyond the shown recent ones. */
  idleHidden: number
}

export function goalsTodosGroupFor(
  status: GoalsTodosStatus | null,
  launchPending = false
): GoalsTodosGroupKind {
  switch (status?.state) {
    case 'waiting':
    case 'blocked':
      return 'needs-you'
    case 'working':
      return 'in-progress'
    case 'done':
    case undefined:
      return launchPending ? 'in-progress' : 'idle'
  }
}

/** Stable per-session key; the row key already includes host, workspace and pane. */
export function goalsTodosKey(session: SidebarSession): string {
  return session.rowKey
}

function sameText(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * The heading and goal line. A session named by the person or its agent keeps that name and
 * shows the goal under it; an unnamed one ("Claude conversation") is headed by its goal.
 */
export function goalsTodosHeading(
  label: string,
  unnamed: boolean,
  goal: SessionGoal | null
): { heading: string; goalLine: string | null } {
  if (!goal) {
    return { heading: label, goalLine: null }
  }
  if (unnamed || !label.trim()) {
    return { heading: goal.line, goalLine: null }
  }
  return { heading: label, goalLine: sameText(label, goal.line) ? null : goal.line }
}

function newestFirst(left: GoalsTodosInput, right: GoalsTodosInput): number {
  return (right.updatedAt ?? -1) - (left.updatedAt ?? -1)
}

/**
 * Which sessions are read at all: everything still going, then the newest finished ones from
 * the last week, capped so a long history never turns into a long scan.
 */
export function selectGoalsTodosInputs(
  inputs: readonly GoalsTodosInput[],
  now: number
): GoalsTodosInput[] {
  const recent = inputs.filter(
    (input) =>
      goalsTodosGroupFor(input.status, input.session.launchPending) !== 'idle' ||
      input.updatedAt === null ||
      now - input.updatedAt <= GOALS_TODOS_MAX_AGE_MS
  )
  return [...recent].sort(newestFirst).slice(0, GOALS_TODOS_MAX_SESSIONS)
}

export function buildGoalsTodosGroups(args: {
  inputs: readonly GoalsTodosInput[]
  details: ReadonlyMap<string, GoalsTodosDetails>
  /** Whether the session's label is only a placeholder such as "Claude conversation". */
  isUnnamed: (session: SidebarSession) => boolean
}): GoalsTodosGroups {
  const groups: GoalsTodosGroups = { 'needs-you': [], 'in-progress': [], idle: [], idleHidden: 0 }
  for (const input of args.inputs) {
    const key = goalsTodosKey(input.session)
    const read = args.details.get(key)
    const todos = read?.todos ?? []
    const progress = agentTodoProgress(todos)
    const named = goalsTodosHeading(
      input.session.label,
      args.isUnnamed(input.session),
      read?.goal ?? null
    )
    const lastMessageAt = read?.lastMessageAt ?? null
    const group = goalsTodosGroupFor(input.status, input.session.launchPending)
    groups[group].push({
      key,
      session: input.session,
      group,
      heading: named.heading,
      goal: read?.goal ?? null,
      goalLine: named.goalLine,
      todos,
      source: read?.source ?? 'none',
      completed: progress.completed,
      total: progress.total,
      current: progress.current,
      updatedAt:
        input.updatedAt === null && lastMessageAt === null
          ? null
          : Math.max(input.updatedAt ?? 0, lastMessageAt ?? 0)
    })
  }
  groups.idleHidden = Math.max(0, groups.idle.length - GOALS_TODOS_IDLE_SHOWN)
  groups.idle = groups.idle.slice(0, GOALS_TODOS_IDLE_SHOWN)
  return groups
}
