import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getSessionChain } from '@/lib/session-chain-registry'
import type { SessionChainRowInfo } from '@/lib/session-chain-support'
import { useAppStore } from '@/store'
import type { AgentTodo } from '../../../../shared/agent-todo-list'
import {
  selectSessionActivity,
  type SessionActivityStatus,
  type SessionActivitySummary
} from './session-activity'

const EMPTY_TODOS: readonly AgentTodo[] = []

/**
 * The hook fields for one pane. Why `useShallow` over the whole entry: the entry object is
 * replaced on every ping, so subscribing to it would rerender every sidebar row on every
 * keystroke of agent output; these few fields change only when the shown line does.
 */
export function useSessionActivityStatus(paneKey: string | null): SessionActivityStatus | null {
  return useAppStore(
    useShallow((store): SessionActivityStatus | null => {
      const entry = paneKey ? store.agentStatusByPaneKey[paneKey] : undefined
      if (!entry) {
        return null
      }
      return {
        state: entry.state,
        stateStartedAt: entry.stateStartedAt,
        ...(entry.workingMode ? { workingMode: entry.workingMode } : {}),
        ...(entry.backgroundTaskCount ? { backgroundTaskCount: entry.backgroundTaskCount } : {}),
        ...(entry.interrupted === true ? { interrupted: true } : {}),
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        ...(entry.toolInput ? { toolInput: entry.toolInput } : {}),
        ...(entry.lastAssistantMessage ? { lastAssistantMessage: entry.lastAssistantMessage } : {}),
        ...(entry.lastAssistantMessageIsToolOutput === true
          ? { lastAssistantMessageIsToolOutput: true }
          : {}),
        ...(entry.lastCompletedAssistantMessage
          ? { lastCompletedAssistantMessage: entry.lastCompletedAssistantMessage }
          : {})
      }
    })
  )
}

/**
 * What one session is doing, derived from state the app already holds: the agent-hook row
 * for its pane, the plan that launched it, and any task list already assembled from its
 * transcript. No timer and no probe of its own — `agentStatusEpoch` is the existing tick
 * that moves the "since" wording, exactly as the dashboard projection does.
 */
export function useSessionActivity(args: {
  paneKey: string | null
  /** From `useLaunchedSessionPlan`; the plan that launched this pane, when one did. */
  launchedBy?: SessionChainRowInfo | null
  todos?: readonly AgentTodo[]
}): SessionActivitySummary {
  const status = useSessionActivityStatus(args.paneKey)
  const agentStatusEpoch = useAppStore((store) => store.agentStatusEpoch)
  const launchedBy = args.launchedBy ?? null
  const todos = args.todos ?? EMPTY_TODOS
  const paneKey = args.paneKey
  return useMemo(() => {
    // Why the void: the epoch is the existing tick that refreshes the "since" wording, so
    // it is a dependency of the result without appearing in the computation.
    void agentStatusEpoch
    return selectSessionActivity({
      chain: launchedBy ? getSessionChain(launchedBy.chainId) : null,
      paneKey,
      status,
      todos
    })
  }, [agentStatusEpoch, launchedBy, paneKey, status, todos])
}
