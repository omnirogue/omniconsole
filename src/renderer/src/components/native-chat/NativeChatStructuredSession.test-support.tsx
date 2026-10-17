import { forwardRef, useImperativeHandle } from 'react'
import { vi, type Mock } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'

type StructuredChatTestMocks = {
  viewerState: 'exited' | 'live' | 'unverifiable'
  fallback: boolean
  header: Mock
  call: Mock
  fileLinkClick: Mock
  isWorking: boolean
  reply: string
  supportsLiveInput: boolean
  mode: 'static' | 'outbox'
  messageListProps: null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
    showTurnStatus?: boolean
    runtimeContext?: unknown
  }
  composerProps: null | {
    structuredTransport?: Record<string, unknown>
    isWorking?: boolean
  }
  handlePasteEvent: Mock
  pasteFromClipboard: Mock
  submissions: unknown[]
  monitoringBackgroundTasks: boolean
  supportsBackgroundTaskStop: boolean
  supportsBackgroundTaskStopAll: boolean
  backgroundTasks: AgentSessionBackgroundTask[]
  stopBackgroundTask: Mock
  rpc: Mock<typeof unknownRpc>
}

const mocks: StructuredChatTestMocks = vi.hoisted(() => ({
  viewerState: 'exited' as 'exited' | 'live' | 'unverifiable',
  fallback: false,
  header: vi.fn(),
  call: vi.fn(),
  fileLinkClick: vi.fn(),
  isWorking: false,
  reply: '[file](file:///repo/src/main.ts)',
  supportsLiveInput: false,
  mode: 'static' as 'static' | 'outbox',
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
    showTurnStatus?: boolean
    runtimeContext?: unknown
  },
  composerProps: null as null | {
    structuredTransport?: Record<string, unknown>
    isWorking?: boolean
  },
  handlePasteEvent: vi.fn(),
  pasteFromClipboard: vi.fn(),
  submissions: [] as unknown[],
  monitoringBackgroundTasks: false,
  supportsBackgroundTaskStop: false,
  supportsBackgroundTaskStopAll: true,
  backgroundTasks: [] as AgentSessionBackgroundTask[],
  stopBackgroundTask: vi.fn(),
  rpc: vi.fn(unknownRpc)
}))

export { mocks }

export function unknownRpc(_target: unknown, method: string, _params?: unknown): Promise<unknown> {
  return Promise.reject(new Error(`unexpected ${method}`))
}

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

vi.mock('./ConversationWorkHeader', () => ({
  ConversationWorkHeader: (props: unknown) => {
    mocks.header(props)
    return <div data-testid="structured-work-header" />
  }
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session', async () => {
  const { useStructuredAgentSessionOutbox } = await import('./use-structured-agent-session-outbox')
  return {
    useStructuredAgentSession: (props: {
      sessionId: string
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
    }) => {
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: props.sessionId,
        target: props.target,
        fence: 1,
        submissions: mocks.submissions as never
      })
      return {
        viewerHold: {
          processState: mocks.viewerState,
          fallback: mocks.fallback,
          error: null,
          resume: vi.fn(async () => true),
          refresh: vi.fn()
        },
        writable: mocks.viewerState === 'live' || mocks.fallback,
        messages:
          mocks.mode === 'outbox'
            ? []
            : [
                {
                  id: 'message-1',
                  role: 'assistant',
                  source: 'transcript',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: mocks.reply }]
                }
              ],
        status: 'ready' as const,
        error: outbox.error,
        hasOlder: false,
        loadingOlder: false,
        loadOlder: vi.fn(),
        prompts: [],
        outbox: outbox.outbox,
        blockedClientMessageId: outbox.blockedClientMessageId,
        send: outbox.send,
        retry: outbox.retry,
        isWorking: mocks.isWorking,
        supportsLiveInput: mocks.supportsLiveInput,
        isMonitoringBackgroundTasks: mocks.monitoringBackgroundTasks,
        supportsBackgroundTaskStop: mocks.supportsBackgroundTaskStop,
        supportsBackgroundTaskStopAll: mocks.supportsBackgroundTaskStopAll,
        backgroundTasks: mocks.backgroundTasks,
        turnId: null,
        cancel: vi.fn(),
        stopBackgroundTask: mocks.stopBackgroundTask,
        respond: vi.fn(),
        optionSnapshot: [
          {
            id: 'model',
            label: 'Model',
            category: 'model',
            kind: {
              type: 'select',
              currentValue: 'gpt-live',
              choices: [{ value: 'gpt-live', label: 'GPT Live' }]
            },
            valueSource: 'reported',
            settable: true
          }
        ],
        optionSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        setStructuredOption: vi.fn()
      }
    }
  }
})

vi.mock('./use-native-chat-font-scale', () => ({
  useNativeChatFontScale: () => ({ scale: 1 })
}))

vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => ({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    runtimeEnvironmentId: null
  })
}))

vi.mock('./use-native-chat-file-link-click', () => ({
  useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
}))

vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: (props: typeof mocks.messageListProps) => {
    mocks.messageListProps = props
    return <div data-testid="message-list" />
  }
}))

vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: forwardRef((props: typeof mocks.composerProps, ref) => {
    mocks.composerProps = props
    useImperativeHandle(ref, () => ({
      focus: () => true,
      insertTypedText: () => true,
      handlePasteEvent: mocks.handlePasteEvent,
      pasteFromClipboard: mocks.pasteFromClipboard
    }))
    return <textarea data-testid="structured-composer" />
  })
}))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({ NativeChatQuestionCard: () => null }))
