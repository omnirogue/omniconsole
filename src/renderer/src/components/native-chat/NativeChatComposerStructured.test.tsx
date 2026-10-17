// The structured-transport half of the composer's behaviour, split out of
// NativeChatComposer.test.tsx to keep both files inside the max-lines budget.
// Grouped rather than sliced arbitrarily: every case here drives a composer wired
// to a structured agent session rather than to a PTY. The mock harness above is
// the sibling file's, verbatim, because a vi.mock factory is hoisted per test
// file and cannot be shared from a module.
// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as workPlanShapes from '../../../../shared/work-plan-shapes'
import * as workPlanCommit from '../../../../shared/work-plan-commit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import { clearNativeChatModelEnrichmentForTests } from './native-chat-session-option-enrichment'
import { resetCodexResumeRelaunchForTests } from './codex-resume-relaunch-state'

const mocks = vi.hoisted(() => ({
  cancelPendingSends: vi.fn(),
  composerIsComposing: null as (() => boolean) | null,
  attachmentIsComposing: null as (() => boolean) | null,
  flushPendingAttachments: vi.fn(),
  fieldProps: null as {
    onSend?: () => void
    onStop?: () => void
    imeEnterGesture?: {
      isComposing: () => boolean
      setComposing: (active: boolean) => void
    }
    onImeSettled?: (element: HTMLTextAreaElement) => void
    sessionOptionsSurface?: SessionOptionsSurface | null
    sessionOptionsSnapshot?: SessionOptionDescriptor[]
    sessionOptionsApplyStatus?: { phase: string } | null
    attachDisabled?: boolean
    disabled?: boolean
    autocomplete?: { mode: string; items?: { kind: string; name: string }[] }
  } | null,
  modelSwitchOutcome: 'applied' as 'applied' | 'rejected' | 'interaction-required' | 'unknown',
  confirmationObserver: null as {
    ready: Promise<void>
    result: Promise<'applied' | 'rejected' | 'interaction-required' | 'unknown'>
    arm: ReturnType<typeof vi.fn>
    startDetection: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  } | null,
  createNativeChatModelSwitchConfirmationObserver: vi.fn(),
  discoverCommitMessageModels: vi.fn(),
  draft: 'hello',
  imageAttachments: [] as { id: string; path: string }[],
  getMainBufferSnapshot: vi.fn(),
  sendHandle: { cancel: vi.fn(), settleAfterMs: 500 },
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  trackPendingSend: vi.fn(),
  setDraft: vi.fn(),
  draftScopeKeys: [] as string[],
  clearNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchDraftAdopted: vi.fn()
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
    clearNativeChatLaunchDraft: mocks.clearNativeChatLaunchDraft,
    markNativeChatLaunchDraftAdopted: mocks.markNativeChatLaunchDraftAdopted
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => mocks.sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => mocks.sendNativeChatTypedCommand(...args),
  sendNativeChatMessageVerified: (...args: unknown[]) =>
    mocks.sendNativeChatMessageVerified(...args),
  typeNativeChatCommand: (...args: unknown[]) => mocks.typeNativeChatCommand(...args),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('./native-chat-model-switch-confirmation', () => ({
  createNativeChatModelSwitchConfirmationObserver: (...args: unknown[]) =>
    mocks.createNativeChatModelSwitchConfirmationObserver(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-draft', () => ({
  useNativeChatDraft: (scopeKey: string) => {
    mocks.draftScopeKeys.push(scopeKey)
    return { draft: mocks.draft, setDraft: mocks.setDraft }
  }
}))
vi.mock('./native-chat-draft-cache', () => ({ readNativeChatDraftCache: () => '' }))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: {
    onSend?: () => void
    onStop?: () => void
    promptEngineer?: React.ReactNode
    promptEngineerStatus?: React.ReactNode
  }) => {
    mocks.fieldProps = props
    return (
      <TooltipProvider>
        <div data-testid="native-chat-composer-field">
          {props.promptEngineer}
          {props.promptEngineerStatus}
        </div>
      </TooltipProvider>
    )
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-composer-attachments', () => ({
  useNativeChatComposerAttachments: (args: { isComposing: () => boolean }) => {
    mocks.attachmentIsComposing = args.isComposing
    return {
      imageAttachments: mocks.imageAttachments,
      referencedAttachments: [],
      attachResolvedPaths: vi.fn(),
      clearImageAttachments: vi.fn(),
      flushPendingAttachments: mocks.flushPendingAttachments,
      removeImageAttachment: vi.fn()
    }
  }
}))
vi.mock('./use-native-chat-composer-paste', () => ({
  useNativeChatComposerPaste: () => ({
    handlePaste: vi.fn(),
    pasteFromClipboard: vi.fn()
  })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: vi.fn()
  })
}))
vi.mock('../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))
vi.mock('./use-native-chat-composer-keydown', () => ({
  useNativeChatComposerKeyDown: (args: { isComposing: () => boolean }) => {
    mocks.composerIsComposing = args.isComposing
    return vi.fn()
  }
}))
vi.mock('./use-native-chat-send-lifecycle', () => ({
  useNativeChatSendLifecycle: () => ({
    cancelPendingSends: mocks.cancelPendingSends,
    trackPendingSend: mocks.trackPendingSend
  })
}))

import { NativeChatComposer } from './NativeChatComposer'

describe('NativeChatComposer over a structured transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearNativeChatSessionOptionCacheForTests()
    clearNativeChatModelEnrichmentForTests()
    resetCodexResumeRelaunchForTests()
    mocks.fieldProps = null
    mocks.modelSwitchOutcome = 'applied'
    mocks.draft = 'hello'
    mocks.imageAttachments = []
    mocks.draftScopeKeys.length = 0
    mocks.confirmationObserver = null
    mocks.composerIsComposing = null
    mocks.attachmentIsComposing = null
    mocks.createNativeChatModelSwitchConfirmationObserver.mockImplementation(() => {
      const observer = {
        ready: Promise.resolve(),
        result: Promise.resolve(mocks.modelSwitchOutcome),
        arm: vi.fn(),
        startDetection: vi.fn(),
        dispose: vi.fn()
      }
      mocks.confirmationObserver = observer
      return observer
    })
    mocks.getMainBufferSnapshot.mockResolvedValue(null)
    mocks.discoverCommitMessageModels.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [
        {
          id: 'opus',
          label: 'Opus',
          thinkingLevels: [
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' }
          ]
        },
        {
          id: 'sonnet',
          label: 'Sonnet',
          thinkingLevels: [
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' }
          ]
        },
        { id: 'fable', label: 'Fable' }
      ]
    })
    mocks.sendNativeChatMessage.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatTypedCommand.mockReturnValue(mocks.sendHandle)
    mocks.sendNativeChatMessageVerified.mockResolvedValue(true)
    mocks.typeNativeChatCommand.mockResolvedValue(true)
    mocks.sendHandle.settleAfterMs = 500
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { discoverCommitMessageModels: mocks.discoverCommitMessageModels },
        pty: { getMainBufferSnapshot: mocks.getMainBufferSnapshot },
        ui: { onFileDrop: () => vi.fn() }
      }
    })
  })

  afterEach(() => cleanup())

  it('routes structured sends and hydrated options through the existing composer', async () => {
    const buildPlan = vi.spyOn(workPlanShapes, 'workPlanFromShape')
    const commitPlan = vi.spyOn(workPlanCommit, 'commitWorkPlan')
    buildPlan.mockClear()
    commitPlan.mockClear()
    const send = vi.fn(() => true)
    const dispatchCommand = vi.fn(async () => ({
      handled: false,
      accepted: false,
      error: null
    }))
    const optionsSurface = {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    } satisfies SessionOptionsSurface
    const optionSnapshot = [{ id: 'model' }] as SessionOptionDescriptor[]
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={{
          send,
          dispatchCommand,
          optionsSurface,
          optionSnapshot,
          onError: vi.fn(),
          runtime: 'local'
        }}
      />
    )

    expect(mocks.fieldProps?.sessionOptionsSurface).toBe(optionsSurface)
    expect(mocks.fieldProps?.sessionOptionsSnapshot).toBe(optionSnapshot)
    expect(mocks.fieldProps?.attachDisabled).toBe(false)
    await act(async () => mocks.fieldProps?.onSend?.())

    expect(dispatchCommand).toHaveBeenCalledWith('hello')
    expect(send).toHaveBeenCalledWith('hello', [])
    expect(buildPlan).not.toHaveBeenCalled()
    expect(commitPlan).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.setDraft).toHaveBeenCalledWith('')
  })

  it('routes wizard refinement and Go to the current structured chat', async () => {
    const send = vi.fn(() => true)
    const dispatchCommand = vi.fn(async () => ({ handled: false, accepted: false, error: null }))
    render(
      <NativeChatComposer
        terminalTabId="wizard-tab"
        paneKey="wizard:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={{
          send,
          dispatchCommand,
          optionsSurface: {
            getSnapshot: () => [],
            setOption: vi.fn(),
            invokeAction: vi.fn(),
            subscribe: () => () => {}
          },
          optionSnapshot: [],
          onError: vi.fn(),
          runtime: 'remote'
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prompt Engineer' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => mocks.fieldProps?.onSend?.())
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining('do not execute the task'), [])
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Go' })))
    expect(send).toHaveBeenLastCalledWith(
      expect.stringContaining('carry out the latest revised prompt in this conversation'),
      []
    )
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull()
  })

  // The structured menu offers only what the dispatcher can carry out. Listing the
  // agent's TUI catalog here answered every pick with "not available in chat sessions".
  it.each([
    ['claude', 'compact'],
    ['codex', 'vim']
  ] as const)('offers %s only actionable structured slash commands', (agent, withheld) => {
    mocks.draft = '/'
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey={`tab-1:structured-${agent}`}
        targetPtyId={null}
        agent={agent}
        structuredTransport={{
          send: vi.fn(() => true),
          dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
          optionsSurface: {
            getSnapshot: () => [],
            setOption: vi.fn(),
            invokeAction: vi.fn(),
            subscribe: () => () => {}
          },
          optionSnapshot: [],
          onError: vi.fn(),
          runtime: 'local'
        }}
      />
    )

    const names = (mocks.fieldProps?.autocomplete?.items ?? [])
      .filter((item) => item.kind === 'command')
      .map((item) => item.name)
    expect(names).toEqual(['model', 'effort'])
    expect(names).not.toContain(withheld)
  })

  it('sends structured image attachments through the durable transport', async () => {
    mocks.draft = ''
    mocks.imageAttachments = [{ id: 'image-1', path: '/tmp/image.png' }]
    const send = vi.fn(() => true)
    render(
      <NativeChatComposer
        terminalTabId="tab-1"
        paneKey="tab-1:structured"
        targetPtyId={null}
        agent="codex"
        structuredTransport={{
          send,
          dispatchCommand: vi.fn(async () => ({
            handled: false,
            accepted: false,
            error: null
          })),
          optionsSurface: {
            getSnapshot: () => [],
            setOption: vi.fn(),
            invokeAction: vi.fn(),
            subscribe: () => () => {}
          },
          optionSnapshot: [],
          worktreeId: 'wt-1',
          onError: vi.fn(),
          runtime: 'local'
        }}
      />
    )

    await act(async () => mocks.fieldProps?.onSend?.())

    expect(send).toHaveBeenCalledWith('', mocks.imageAttachments)
    expect(mocks.setDraft).toHaveBeenCalledWith('')
  })
})
