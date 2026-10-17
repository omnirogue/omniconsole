import { useSessionPaneChatController } from './use-session-pane-chat-controller'
import { NextStepsTray } from '../next-steps/NextStepsTray'
import { NextStepsStartTray } from '../next-steps/NextStepsStartTray'
import { ConversationWorkHeader } from './ConversationWorkHeader'
import { NativeChatSessionPlan } from './NativeChatPlanChecklist'
import { NativeChatTaskSaveStatus } from './NativeChatTaskSaveStatus'
import { useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type {
  AgentStatusOrchestrationContext,
  AgentType
} from '../../../../shared/agent-status-types'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { structuredConversationSource } from '../../../../shared/conversation-source'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { sessionPrepConversationContext } from './session-prep-context'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatConnectionNotice } from './NativeChatConnectionNotice'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { selectNativeChatViewState } from './native-chat-view-state'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { translate } from '@/i18n/i18n'
import { NativeChatOrchestrationPausedNotice } from './NativeChatOrchestrationPausedNotice'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { StructuredSessionViewerNotice } from './StructuredSessionViewerNotice'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

function encodeQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

type StoppingBackgroundTasks = {
  sessionId: string
  taskIds: ReadonlySet<string>
  all: boolean
}

const NO_STOPPING_TASKS: ReadonlySet<string> = new Set()

export function NativeChatStructuredSession(props: {
  worktreeId: string
  tabId: string
  workRailInShell?: boolean
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  viewer?: boolean
  orchestrationDispatchStatus?: AgentStatusOrchestrationContext['dispatchStatus']
}): React.JSX.Element {
  const controller = useStructuredAgentSession(props)
  useSessionPaneChatController(props, controller)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [stoppingBackgroundTasks, setStoppingBackgroundTasks] =
    useState<StoppingBackgroundTasks | null>(null)
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
  } | null>(null)
  const paneKey = useMemo(
    () => structuredAgentSessionPaneKey(props.tabId, props.sessionId),
    [props.sessionId, props.tabId]
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  useNativeChatPasteBridge({ rootRef, composerRef })
  const session = useMemo<NativeChatLiveSession>(
    () => ({
      messages: controller.messages,
      status:
        controller.status === 'error'
          ? 'error'
          : controller.status === 'loading'
            ? 'loading'
            : controller.isWorking
              ? 'working'
              : controller.messages.length === 0
                ? 'empty'
                : 'ready',
      sessionId: props.sessionId,
      agent: props.agent,
      ...(controller.error ? { error: controller.error } : {}),
      hasMore: controller.hasOlder,
      loadingEarlier: controller.loadingOlder,
      loadEarlier: () => void controller.loadOlder(),
      retry: controller.refresh,
      readPhase:
        controller.status === 'loading'
          ? 'loading'
          : controller.status === 'error'
            ? 'error'
            : 'ready'
    }),
    [controller, props.agent, props.sessionId]
  )
  const viewState = selectNativeChatViewState(session)
  const fontScale = useNativeChatFontScale(viewState.kind === 'ready')
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const fileLinkClick = useNativeChatFileLinkClick(fileLinkContext)
  const activeStoppingBackgroundTasks =
    stoppingBackgroundTasks?.sessionId === props.sessionId ? stoppingBackgroundTasks : null
  const prompt = controller.prompts[0] ?? null
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const retryableOutboxEntry =
    controller.outbox.find((entry) => entry.state === 'unconfirmed') ??
    controller.outbox.find(
      (entry) => entry.clientMessageId === controller.blockedClientMessageId
    ) ??
    null
  const sendUnavailableReason =
    (controller.isWorking || controller.outbox.length > 0) && !controller.supportsLiveInput
      ? props.agent === 'codex'
        ? 'This session host needs an update to send while Codex is working. Your draft is kept. You can also add a Next Step above.'
        : 'This chat cannot accept messages while the agent is working. Your draft is kept. Wait for it to finish, or add a Next Step above.'
      : undefined
  const structuredTransport = useMemo(
    () => ({
      send: (text: string, attachments: readonly { id: string; path: string }[]): boolean => {
        if (sendUnavailableReason) {
          throw new Error(sendUnavailableReason)
        }
        return controller.send(
          text,
          attachments.map((attachment) => ({
            path: attachment.path,
            previewUri: attachment.path
          }))
        )
      },
      dispatchCommand: (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent: props.agent,
          snapshot: controller.optionSnapshot,
          invokeAction: async (id) => {
            setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
            return true
          },
          setOption: controller.setStructuredOption,
          conversationCommands: controller.conversationCommands,
          runConversationCommand: controller.runConversationCommand
        }),
      sendUnavailableReason,
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      worktreeId: fileLinkContext?.worktreeId,
      onError: setComposerError,
      runtime: (props.target.kind === 'local' ? 'local' : 'remote') as 'local' | 'remote'
    }),
    [
      controller,
      fileLinkContext?.worktreeId,
      optionPickerRequest,
      props.agent,
      props.target.kind,
      sendUnavailableReason
    ]
  )

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={controller.isWorking ? 'true' : 'false'}
      tabIndex={-1}
      className="flex h-full min-h-0 w-full flex-col bg-background focus:outline-none"
    >
      {!props.workRailInShell ? (
        <ConversationWorkHeader
          worktreeId={props.worktreeId}
          paneKey={paneKey}
          tabId={props.tabId}
          messages={controller.messages}
        />
      ) : null}
      {props.viewer ? <StructuredSessionViewerNotice hold={controller.viewerHold} /> : null}
      <NativeChatSessionPlan key={`plan:${paneKey}`} messages={controller.messages} />
      <NativeChatOrchestrationPausedNotice dispatchStatus={props.orchestrationDispatchStatus} />
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState
            kind="error"
            message={viewState.message}
            onRetry={controller.refresh}
          />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" agent={props.agent} />
        ) : (
          <NativeChatMessageList
            session={session}
            journalItems={controller.journalItems}
            isWorking={controller.isWorking}
            expandSignal={false}
            fontScale={fontScale.scale}
            workingStartedAt={null}
            showTurnStatus
            onLinkClick={fileLinkClick}
            allowFileUriLinks={fileLinkClick !== undefined}
          />
        )}
      </div>
      {/* Why the outbox: a launch prompt in flight is already the first message. */}
      {viewState.kind === 'empty' &&
      (!props.viewer || controller.writable) &&
      props.target.kind === 'local' &&
      controller.outbox.length === 0 ? (
        <NextStepsStartTray
          worktreeId={props.worktreeId}
          paneKey={paneKey}
          tabId={props.tabId}
          agent={props.agent}
          conversation={structuredConversationSource(props.worktreeId, props.sessionId)}
          active={props.isVisible && controller.status === 'ready' && !prompt}
        />
      ) : null}
      <NextStepsTray
        key={`recommendations:${paneKey}`}
        messages={controller.messages}
        paneKey={paneKey}
        tabId={props.tabId}
        disabled={
          (props.viewer && !controller.writable) ||
          controller.isWorking ||
          !!prompt ||
          controller.status !== 'ready' ||
          controller.outbox.length > 0
        }
        visible={props.isVisible}
        conversation={
          props.target.kind === 'local'
            ? structuredConversationSource(props.worktreeId, props.sessionId)
            : null
        }
      />
      {(!props.viewer || controller.writable) && prompt?.body.kind === 'approval' ? (
        <NativeChatApprovalCard
          approval={{
            title: prompt.body.title,
            ...(prompt.body.detail ? { detail: prompt.body.detail } : {}),
            options: prompt.body.options.map((option) => ({
              label: option.label,
              send: option.id
            }))
          }}
          onChoose={(optionId) => void controller.respond(prompt, optionId)}
        />
      ) : null}
      {(!props.viewer || controller.writable) && prompt && questionBody ? (
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: questionBody.question,
                multiSelect: false,
                options: questionBody.options.map((option) => ({ label: option.label }))
              }
            ]
          }}
          allowOther={Boolean(questionBody.freeTextQuestionId)}
          onAnswer={(answers) => {
            const index = answers[0]?.indices[0]
            const other = answers[0]?.other?.trim()
            const optionId =
              typeof index === 'number'
                ? questionBody.options[index]?.id
                : questionBody.freeTextQuestionId && other
                  ? encodeQuestionAnswer(questionBody.freeTextQuestionId, other)
                  : undefined
            if (optionId) {
              void controller.respond(prompt, optionId)
            }
          }}
          onCancel={() => {
            if (controller.turnId) {
              void controller.cancel(controller.turnId)
            }
          }}
        />
      ) : null}
      {controller.readError && controller.messages.length > 0 ? (
        <NativeChatConnectionNotice error={controller.readError} onRetry={controller.refresh} />
      ) : null}
      <NativeChatTaskSaveStatus status={controller.taskSave} />
      {retryableOutboxEntry ? (
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-muted-foreground">
          <span>
            {retryableOutboxEntry.state === 'unconfirmed'
              ? translate(
                  'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
                  'Message delivery is unconfirmed.'
                )
              : translate(
                  'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
                  'Message was not sent.'
                )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={props.viewer && !controller.writable}
            onClick={() => controller.retry(retryableOutboxEntry.clientMessageId)}
          >
            <RotateCcw className="size-3" />
            {translate(
              'auto.components.native.chat.NativeChatStructuredSession.a5e7f14068',
              'Retry'
            )}
          </Button>
        </div>
      ) : null}
      {controller.error || composerError ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-destructive">
          {controller.error ?? composerError}
        </p>
      ) : null}
      {(!props.viewer || controller.writable) && controller.isMonitoringBackgroundTasks ? (
        <NativeChatBackgroundTasksStatus
          tasks={controller.backgroundTasks}
          supportsTaskStop={controller.supportsBackgroundTaskStop}
          supportsStopAll={controller.supportsBackgroundTaskStopAll}
          stoppingTaskIds={activeStoppingBackgroundTasks?.taskIds ?? NO_STOPPING_TASKS}
          stoppingAll={activeStoppingBackgroundTasks?.all ?? false}
          onStop={(taskId) => {
            const targetSessionId = props.sessionId
            setStoppingBackgroundTasks((current) => {
              const taskIds = new Set(
                current?.sessionId === targetSessionId ? current.taskIds : NO_STOPPING_TASKS
              )
              if (taskId) {
                taskIds.add(taskId)
              }
              return {
                sessionId: targetSessionId,
                taskIds,
                all: taskId ? current?.sessionId === targetSessionId && current.all : true
              }
            })
            void controller.stopBackgroundTask(taskId).finally(() => {
              setStoppingBackgroundTasks((current) => {
                if (current?.sessionId !== targetSessionId) {
                  return current
                }
                const taskIds = new Set(current.taskIds)
                if (taskId) {
                  taskIds.delete(taskId)
                }
                const all = taskId ? current.all : false
                return taskIds.size === 0 && !all
                  ? null
                  : { sessionId: targetSessionId, taskIds, all }
              })
            })
          }}
        />
      ) : null}
      {prompt || (props.viewer && !controller.writable) ? null : (
        <NativeChatComposer
          ref={composerRef}
          terminalTabId={props.tabId}
          paneKey={paneKey}
          targetPtyId={null}
          agent={props.agent}
          canSend={!prompt}
          isWorking={controller.isWorking}
          onStop={() => {
            if (controller.turnId) {
              void controller.cancel(controller.turnId)
            }
          }}
          structuredTransport={structuredTransport}
          getConversationContext={() => sessionPrepConversationContext(session.messages)}
        />
      )}
    </div>
  )
}
