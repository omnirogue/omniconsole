// @vitest-environment happy-dom

import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fieldProps: null as {
    onSend?: () => void
    sendButtonDisabled?: boolean
    stopDisabled?: boolean
    sendLabel?: string
    isWorking?: boolean
    notice?: string | null
  } | null,
  draft: 'Improve the copy',
  setDraft: vi.fn(),
  queuePrompt: vi.fn(() => false),
  queueReport: null as null | ((message: string) => void),
  sendNativeChatMessage: vi.fn(),
  sendHandle: { cancel: vi.fn(), settleAfterMs: 500 }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))
vi.mock('@/components/work-plan/use-work-plan-context', () => ({
  useWorkPlanContext: () => ({
    usableAgents: [],
    source: null,
    placement: 'local',
    accountCatalogue: [],
    commitSource: 'user',
    capabilities: { sameConversationRoute: false }
  })
}))
vi.mock('@/hooks/useWorkSessionOptions', () => ({
  useWorkSessionOptions: (args: { surface: unknown; snapshot: unknown }) => args
}))
vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(async () => true),
  typeNativeChatCommand: vi.fn(async () => true),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: () => ({ draft: mocks.draft, setDraft: mocks.setDraft })
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: typeof mocks.fieldProps) => {
    mocks.fieldProps = props
    return <div data-testid="native-chat-composer-field" />
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: () => ({
    imageAttachments: [],
    referencedAttachments: [],
    attachResolvedPaths: vi.fn(),
    clearImageAttachments: vi.fn(),
    flushPendingAttachments: vi.fn(),
    removeImageAttachment: vi.fn()
  })
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({ handlePaste: vi.fn(), pasteFromClipboard: vi.fn() })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('../dictation/dictation-control-events', () => ({ dispatchDictationControl: vi.fn() }))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: () => vi.fn()
}))
vi.mock('./use-native-chat-send-lifecycle', () => ({
  useNativeChatSendLifecycle: () => ({ cancelPendingSends: vi.fn(), trackPendingSend: vi.fn() })
}))
// The door (brief 78 #7): both hooks resolve the pane's Up next address at submission.
vi.mock('@/components/prompt-queue/use-prompt-queue-command', () => ({
  usePromptQueueCommand: (
    _pane: string,
    _tab: string,
    _setDraft: unknown,
    report: (message: string) => void
  ) => {
    mocks.queueReport = report
    return mocks.queuePrompt
  }
}))

import { NativeChatComposer } from './NativeChatComposer'

const mount = (
  isWorking: boolean,
  agent: AgentType = 'codex',
  structuredTransport?: NativeChatStructuredComposerTransport
) =>
  render(
    <NativeChatComposer
      terminalTabId="tab-1"
      paneKey="tab-1:leaf-1"
      targetPtyId="pty-1"
      agent={agent}
      isWorking={isWorking}
      onStop={vi.fn()}
      structuredTransport={structuredTransport}
    />
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fieldProps = null
  mocks.draft = 'Improve the copy'
  mocks.queuePrompt.mockReturnValue(false)
  mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { getMainBufferSnapshot: vi.fn(async () => null) },
      ui: { onFileDrop: () => vi.fn() }
    }
  })
})
afterEach(() => cleanup())

describe('the composer delivers chat independently of Next Steps', () => {
  it('idle: the primary reads Send and the line goes now through the composer’s own delivery', () => {
    mount(false)
    expect(mocks.fieldProps?.isWorking).toBe(false)
    act(() => mocks.fieldProps?.onSend?.())
    expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
      {},
      'pty-1',
      'Improve the copy',
      undefined
    )
  })

  it.each(['codex', 'claude', 'grok', 'omp'] as const)(
    'busy %s: a regular message reaches its native transport',
    (agent) => {
      mount(true, agent)
      expect(mocks.fieldProps?.isWorking).toBe(true)
      expect(mocks.fieldProps?.sendButtonDisabled).toBe(false)
      act(() => mocks.fieldProps?.onSend?.())
      expect(mocks.sendNativeChatMessage).toHaveBeenCalledWith(
        {},
        'pty-1',
        'Improve the copy',
        agent === 'omp' ? { agent: 'omp' } : undefined
      )
    }
  )
  it('explains unavailable live input while retaining the draft, Stop, and explicit Next Steps', () => {
    const transport: NativeChatStructuredComposerTransport = {
      sendUnavailableReason: 'Wait for the current turn or add a Next Step above.',
      send: vi.fn(() => false),
      dispatchCommand: vi.fn(),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: vi.fn(),
      runtime: 'local'
    }
    const view = mount(true, 'grok', transport)
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(true)
    expect(mocks.fieldProps?.stopDisabled).toBe(false)
    expect(mocks.fieldProps?.notice).toBe(transport.sendUnavailableReason)
    expect(mocks.setDraft).not.toHaveBeenCalled()
    view.unmount()
    mocks.draft = '/next Improve the copy'
    mount(true, 'grok', transport)
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(false)
    act(() => mocks.queueReport?.('Next Step could not be saved.'))
    expect(mocks.fieldProps?.notice).toContain('Next Step could not be saved.')
    expect(mocks.fieldProps?.notice).toContain(transport.sendUnavailableReason)
  })

  it('keeps Stop enabled when the busy composer is empty', () => {
    mocks.draft = ''
    mount(true)
    expect(mocks.fieldProps?.sendButtonDisabled).toBe(true)
    expect(mocks.fieldProps?.stopDisabled).toBe(false)
  })
})
