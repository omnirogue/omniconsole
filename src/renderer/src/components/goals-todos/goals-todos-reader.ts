// Reads a session's goal and to-do list from files the agent already wrote, through the two
// read-only paths the app already has: the chat view's transcript tail reader and Agent
// Session History's first-prompt reader. Nothing is written, sent or launched.

import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  firstSessionGoalInMessages,
  sessionGoalFromPrompt,
  type SessionGoal
} from '../../../../shared/session-goal'
import { sessionPullRequestMentions } from '../../../../shared/session-pull-request-refs'
import { compactSessionContext } from '../../../../shared/session-compact-context'
import { latestSessionTodoList } from '../../../../shared/session-todo-list'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { GoalsTodosDetails } from './goals-todos-rows'

/** Tail window per read: enough for the latest list, small enough to stay a cheap read. */
export const GOALS_TODOS_READ_WINDOW = 150
/** A first-prompt miss is retried at most this often; a hit is kept for the session's life. */
const GOAL_MISS_RETRY_MS = 5 * 60_000
const GOAL_CACHE_MAX = 500

export type GoalsTodosTranscriptRef = {
  agent: string
  sessionId: string
  transcriptPath?: string
}

/** The transcript behind a row, or null when there is none on this computer to read. */
export function goalsTodosTranscriptRef(session: SidebarSession): GoalsTodosTranscriptRef | null {
  const provider = session.providerSession
  // Why local only: transcripts live on the session's host, and remote reads are not free.
  if (!provider?.id || session.kind !== 'terminal' || session.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  return {
    agent: session.agent,
    sessionId: provider.id,
    ...(provider.transcriptPath ? { transcriptPath: provider.transcriptPath } : {})
  }
}

const goalCache = new Map<string, { goal: SessionGoal | null; at: number }>()

function goalCacheKey(ref: GoalsTodosTranscriptRef): string {
  return `${ref.agent}\u0000${ref.transcriptPath ?? ref.sessionId}`
}

function rememberGoal(key: string, goal: SessionGoal | null): void {
  goalCache.delete(key)
  goalCache.set(key, { goal, at: Date.now() })
  if (goalCache.size > GOAL_CACHE_MAX) {
    const oldest = goalCache.keys().next().value
    if (oldest !== undefined) {
      goalCache.delete(oldest)
    }
  }
}

function isAiVaultAgent(agent: string): agent is AiVaultAgent {
  return (AI_VAULT_AGENTS as readonly string[]).includes(agent)
}

async function readFirstPromptGoal(ref: GoalsTodosTranscriptRef): Promise<SessionGoal | null> {
  const read = window.api.aiVault?.getFirstUserPrompt
  if (!ref.transcriptPath || !isAiVaultAgent(ref.agent) || typeof read !== 'function') {
    return null
  }
  try {
    const result = await read({
      agent: ref.agent,
      filePath: ref.transcriptPath,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    return sessionGoalFromPrompt(result.prompt)
  } catch {
    return null
  }
}

/**
 * The goal: the first genuine prompt. A window shorter than its limit holds the whole session,
 * so its first prompt is the real one; otherwise the first prompt is read once and kept.
 */
async function resolveGoal(
  ref: GoalsTodosTranscriptRef,
  messages: readonly NativeChatMessage[]
): Promise<SessionGoal | null> {
  const key = goalCacheKey(ref)
  const cached = goalCache.get(key)
  if (cached?.goal) {
    return cached.goal
  }
  if (messages.length < GOALS_TODOS_READ_WINDOW) {
    const goal = firstSessionGoalInMessages(messages)
    if (goal) {
      rememberGoal(key, goal)
      return goal
    }
  }
  if (cached && Date.now() - cached.at < GOAL_MISS_RETRY_MS) {
    return null
  }
  const goal = await readFirstPromptGoal(ref)
  rememberGoal(key, goal)
  return goal
}

function newestTimestamp(messages: readonly NativeChatMessage[]): number | null {
  let newest: number | null = null
  for (const message of messages) {
    if (message.timestamp !== null && (newest === null || message.timestamp > newest)) {
      newest = message.timestamp
    }
  }
  return newest
}

const EMPTY_DETAILS: GoalsTodosDetails = {
  goal: null,
  todos: [],
  source: 'none',
  lastMessageAt: null
}

/** One session's goal and list; an unreadable transcript reads as "nothing published yet". */
export async function readGoalsTodosDetails(
  ref: GoalsTodosTranscriptRef
): Promise<GoalsTodosDetails> {
  let messages: readonly NativeChatMessage[]
  try {
    const result = await window.api.nativeChat.readSession(
      ref.agent,
      ref.sessionId,
      GOALS_TODOS_READ_WINDOW,
      ref.transcriptPath
    )
    if ('error' in result) {
      return EMPTY_DETAILS
    }
    messages = result.messages
  } catch {
    return EMPTY_DETAILS
  }
  const list = latestSessionTodoList(messages)
  const goal = await resolveGoal(ref, messages)
  const indexed = goal?.mission
    ? await window.api.sessionFiles
        ?.indexedPullRequests?.({ agent: ref.agent, sessionId: ref.sessionId })
        .catch(() => null)
    : null
  const mentions = sessionPullRequestMentions(messages)
  const fromIndex =
    indexed?.map((pr, index) => ({ ...pr, firstOrder: index, lastOrder: index, firstAt: null })) ??
    []
  const pullRequests = [
    ...new Map(
      [...fromIndex, ...mentions].map((pr) => [
        `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(),
        pr
      ])
    ).values()
  ]
  return {
    goal,
    context: compactSessionContext(messages, goal),
    todos: list.todos,
    source: list.source,
    lastMessageAt: newestTimestamp(messages),
    pullRequests
  }
}
