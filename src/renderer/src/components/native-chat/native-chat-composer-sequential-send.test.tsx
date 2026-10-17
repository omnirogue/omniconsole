// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as translationModule from '@/i18n/i18n'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat-agent-profiles'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

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
  useWorkSessionOptions: (args: { surface: unknown; snapshot: unknown }) => ({
    surface: args.surface,
    snapshot: args.snapshot
  })
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof translationModule>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: (props: { promptEngineer?: React.ReactNode }) => (
    <div data-testid="composer-actions">{props.promptEngineer}</div>
  )
}))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('../../store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
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
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('./native-chat-model-switch-confirmation', () => ({
  createNativeChatModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock('../../../../shared/native-chat-agent-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof nativeChatAgentProfiles>()),
  getVerifiedNativeChatCommands: () => []
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('../dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))
const typing = vi.hoisted(() => vi.fn())
vi.mock('../next-steps/next-steps-person-typing', () => ({
  notePersonTypingInConversation: typing
}))

import { NativeChatComposer } from './NativeChatComposer'
import { TooltipProvider } from '@/components/ui/tooltip'

// Post-merge review of #159 asked whether routing chat sends through the wizard's
// in-flight guard could drop or erase a message typed while an earlier structured
// send was "in flight". It cannot: the REAL command dispatch returns immediately for
// chat text and `transport.send` is synchronous, so the guard and the draft clear
// both settle inside the Enter event. These tests pin that with the real dispatch,
// not a deferred mock, so a future genuinely-awaiting path would surface here.
function transport(): NativeChatStructuredComposerTransport {
  return {
    send: vi.fn(() => true),
    dispatchCommand: (text: string) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'remote'
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

function press(input: HTMLTextAreaElement, key: 'Enter' | 'ArrowUp'): void {
  fireEvent.keyDown(input, { key, keyCode: key === 'Enter' ? 13 : 38, isComposing: false })
}

let paneCounter = 0

function renderComposer(structuredTransport: NativeChatStructuredComposerTransport): void {
  paneCounter += 1
  render(
    <TooltipProvider>
      <NativeChatComposer
        terminalTabId={`tab-${paneCounter}`}
        paneKey={`tab-${paneCounter}:sequential`}
        targetPtyId={null}
        agent="codex"
        structuredTransport={structuredTransport}
      />
    </TooltipProvider>
  )
}

describe('structured chat sends typed back to back', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
        pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) },
        ui: { onFileDrop: () => vi.fn() }
      }
    })
  })

  afterEach(() => cleanup())

  it('delivers the next message and never clears it with the previous send (wizard off)', async () => {
    const structured = transport()
    renderComposer(structured)
    const input = textarea()

    fireEvent.change(input, { target: { value: 'first' } })
    await act(async () => press(input, 'Enter'))
    expect(structured.send).toHaveBeenCalledWith('first', [])
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: 'second' } })
    expect(input.value).toBe('second')
    await act(async () => press(input, 'Enter'))
    expect(structured.send).toHaveBeenCalledTimes(2)
    expect(structured.send).toHaveBeenLastCalledWith('second', [])
    expect(input.value).toBe('')
  })

  it('keeps wizard refinements sequential and recalls the raw draft, not the wrapper', async () => {
    const structured = transport()
    renderComposer(structured)
    const input = textarea()
    fireEvent.click(screen.getByRole('button', { name: 'Prompt Engineer' }))

    fireEvent.change(input, { target: { value: 'first idea' } })
    await act(async () => press(input, 'Enter'))
    expect(structured.send).toHaveBeenLastCalledWith(expect.stringContaining('first idea'), [])
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: 'second idea' } })
    await act(async () => press(input, 'Enter'))
    expect(structured.send).toHaveBeenCalledTimes(2)
    expect(structured.send).toHaveBeenLastCalledWith(
      expect.stringContaining('do not execute the task'),
      []
    )
    expect(structured.send).toHaveBeenLastCalledWith(expect.stringContaining('second idea'), [])
    expect(input.value).toBe('')

    // Up-arrow recall returns the user's words, not the wizard instruction.
    await act(async () => press(input, 'ArrowUp'))
    expect(input.value).toBe('second idea')
    await act(async () => press(input, 'ArrowUp'))
    expect(input.value).toBe('first idea')
  })
})

describe('typing in the composer', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
        pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) },
        ui: { onFileDrop: () => vi.fn() }
      }
    })
    typing.mockClear()
  })

  afterEach(() => cleanup())

  it('tells Keep going the person is typing in this conversation, before anything is sent', () => {
    renderComposer(transport())
    fireEvent.change(textarea(), { target: { value: 'wait' } })
    expect(typing).toHaveBeenCalledWith(`tab-${paneCounter}:sequential`)
  })
})
