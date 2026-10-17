import { useEffect, useMemo, useRef, useState } from 'react'
import * as conversationCommands from './structured-conversation-command-send'
import type {
  AgentSessionOptionsResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import {
  projectStructuredAgentSessionMessages,
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredAgentSessionOptionSurface } from './use-structured-agent-session-option-surface'

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  viewer?: boolean
}) {
  const { agent, isVisible, sessionId, target, viewer } = args
  // Hold first: a viewer restores readable history without resuming the child.
  const hold = useStructuredAgentSessionHold({
    sessionId,
    target,
    surface: 'desktop-chat',
    enabled: isVisible,
    ...(viewer ? { mode: 'viewer' as const } : {})
  })
  const writable = !viewer || (isVisible && (hold.processState === 'live' || hold.fallback))
  const { state, loadingOlder, loadOlder, refresh } = useStructuredAgentSessionRead({
    ...args,
    isVisible: isVisible && (!viewer || hold.processState !== 'checking')
  })
  useEffect(() => {
    if (viewer && isVisible && hold.processState === 'live') {
      refresh()
    }
  }, [viewer, isVisible, hold.processState, refresh])
  const stateRef = useRef(state)
  const { mutate, writeError } = useStructuredAgentSessionMutate({ sessionId, target, stateRef })
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    supportsLiveInput: boolean
    fence: number | null
    target: RuntimeClientTarget
  } | null>(null)
  const commandPending = useRef(false)
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent)
  )
  const activeOptionRecordRef = useRef(optionState.record)
  const optionCatalog = useMemo(() => getAgentSessionOptionCatalog(agent), [agent])
  const outboxController = useStructuredAgentSessionOutbox({
    sessionId,
    target,
    fence: state.fence,
    submissions: state.submissions,
    enabled: writable
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent)
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, sessionId, state.fence])

  // Refresh options each turn to confirm which model the provider actually selected.
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const backgroundTasksView = structuredSessionBackgroundTasksView(state.backgroundTasks, turnId)

  useEffect(() => {
    if (!isVisible || !writable || !optionCatalog) {
      return
    }
    let stale = false
    void callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
      sessionId
    })
      .then((result) => {
        if (!stale) {
          setConversationSupport({
            sessionId,
            commands: result.conversationCommands ?? [],
            supportsLiveInput: result.supportsLiveInput === true,
            fence: state.fence,
            target
          })
          setOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
              : current
          )
        }
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [isVisible, writable, optionCatalog, sessionId, state.fence, target, turnId])

  const { optionSnapshot, setStructuredOption, optionSurface } =
    useStructuredAgentSessionOptionSurface({
      agent,
      target,
      optionState,
      setOptionState,
      activeOptionRecordRef,
      mutate
    })

  const prompts = pendingStructuredSessionPrompts(state.items)
  const { outbox } = outboxController
  const messages = projectStructuredAgentSessionMessages(state.items, outbox, state.submissions)
  return {
    viewerHold: hold,
    writable,
    supportsLiveInput:
      conversationSupport?.sessionId === sessionId &&
      conversationSupport.fence === state.fence &&
      conversationSupport.target === target &&
      conversationSupport.supportsLiveInput,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : [],
    runConversationCommand: (command: AgentSessionConversationCommand) =>
      conversationCommands.sendStructuredConversationCommand({
        command,
        pending: commandPending,
        blocked: Boolean(
          !writable ||
          turnId ||
          prompts.length ||
          backgroundTasksView.isMonitoringBackgroundTasks ||
          outbox.length
        ),
        send: (command) =>
          mutate<AgentSessionConversationCommandResult>(
            'agentSession.conversationCommand',
            'agentSession.conversationCommand',
            { command }
          )
      }),
    journalItems: state.items,
    messages,
    status: state.status,
    readError: state.status === 'error' ? state.error : undefined,
    refresh,
    error: state.error ?? writeError ?? outboxController.error,
    hasOlder: state.hasOlder,
    taskSave: state.taskSave,
    loadingOlder,
    loadOlder,
    prompts,
    outbox,
    blockedClientMessageId: outboxController.blockedClientMessageId,
    send: (...input: Parameters<typeof outboxController.send>) =>
      writable && !commandPending.current && outboxController.send(...input),
    retry: (id: string) => {
      if (writable) {
        outboxController.retry(id)
      }
    },
    isWorking: turnId !== null,
    ...backgroundTasksView,
    turnId,
    cancel: (turnId: string) => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }),
    stopBackgroundTask: (taskId?: string) =>
      mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
      }),
    respond: (item: StructuredPromptItem, optionId: string) =>
      mutate<AgentSessionPromptResult>(
        item.body.kind === 'approval'
          ? 'agentSession.respondToApproval'
          : 'agentSession.respondToQuestion',
        `agentSession.respondTo:${item.body.kind}`,
        { itemId: item.itemId, expectedRevision: item.revision, optionId }
      ),
    optionSnapshot,
    optionSurface,
    setStructuredOption
  }
}
