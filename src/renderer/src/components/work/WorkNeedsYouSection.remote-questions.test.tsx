// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import type { NativeChatInteractiveSend } from '@/components/native-chat/use-native-chat-interactive-send'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

const TAB = 'web-terminal-rental-test'
const LEAF = '11111111-2222-4333-8444-555555555555'
const PANE = `${TAB}:${LEAF}`
const ENV = 'rental-test'
const mocks = vi.hoisted(() => ({
  state: {} as {
    settings: { sessionQuestions: { inlineAnswers: boolean } }
    agentStatusByPaneKey: Record<string, Record<string, unknown>>
    terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
    runtimeStatusByEnvironmentId: Map<string, { status: object | null }>
  },
  panes: [] as AttentionPane[],
  sessions: [] as SidebarSession[],
  sendAnswer: vi.fn(),
  nativeSend: vi.fn(),
  open: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'all' }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => mocks.sessions
}))
vi.mock('@/components/task-page/backoffice/backoffice-needs-you-counts', () => ({
  useNeedsYouCounts: () => ({
    panes: mocks.panes,
    views: { needsYou: [], gaps: [] },
    counts: { total: mocks.panes.length },
    loading: false
  })
}))
vi.mock('@/components/next-action/UpNextControls', () => ({ UpNextControls: () => null }))
vi.mock('@/components/attention/RunAttentionAction', () => ({ RunAttentionAction: () => null }))
vi.mock('./WorkDecisionsBox', () => ({
  WorkDecisionsBox: () => <div data-local-decisions="">Local decision queue</div>
}))
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: mocks.open }))
vi.mock('@/components/native-chat/use-native-chat-can-send', () => ({
  useNativeChatCanSend: () => true
}))
vi.mock('@/components/native-chat/use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: mocks.nativeSend
}))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

import { WorkNeedsYouSection } from './WorkNeedsYouSection'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendAnswer.mockReturnValue({ settleAfterMs: 0, waitsForVerifiedDelivery: false })
  mocks.open.mockResolvedValue(true)
  mocks.nativeSend.mockReturnValue({
    sendAnswer: mocks.sendAnswer,
    sendApproval: vi.fn(),
    sendRaw: vi.fn(),
    cancelPending: vi.fn(),
    cancel: vi.fn()
  } satisfies NativeChatInteractiveSend)
  mocks.state = {
    settings: { sessionQuestions: { inlineAnswers: true } },
    agentStatusByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        state: 'waiting',
        agentType: 'claude',
        interactivePrompt: JSON.stringify({
          questions: [
            {
              question: 'Which colour should this rental use?',
              multiSelect: false,
              options: [{ label: 'Blue' }, { label: 'Green' }]
            }
          ]
        }),
        toolName: 'AskUserQuestion',
        stateStartedAt: 1_000,
        terminalHandle: 'term-test',
        connectionId: null
      }
    },
    terminalLayoutsByTabId: {
      [TAB]: { ptyIdsByLeafId: { [LEAF]: toRemoteRuntimePtyId('term-test', ENV) } }
    },
    runtimeStatusByEnvironmentId: new Map([[ENV, { status: { runtimeId: 'runtime-test' } }]])
  }
  mocks.panes = [
    {
      paneKey: PANE,
      worktreeId: 'wt-test',
      tabId: TAB,
      leafId: LEAF,
      agentType: 'claude',
      bucket: 'attention',
      dotState: 'waiting',
      unseen: false,
      title: 'Rental question',
      stateChangedAt: 1_000,
      repoName: 'Test',
      worktreeName: 'Fleet test',
      cause: 'waiting',
      portalPaneKey: PANE
    }
  ]
  mocks.sessions = [
    {
      rowKey: 'rental-row',
      sessionKey: null,
      worktreeId: 'wt-test',
      hostId: `runtime:${ENV}`,
      tabId: TAB,
      paneKey: PANE,
      kind: 'terminal',
      label: 'Rental question',
      workspaceLabel: 'Fleet test',
      agent: 'claude',
      unavailable: false,
      folderKeyMigration: null
    }
  ]
})
afterEach(cleanup)

it.each(['claude', 'codex'] as const)(
  'keeps an unverified paired %s question on Open without mounting the terminal send hook',
  (agent) => {
    mocks.state.agentStatusByPaneKey[PANE]!.agentType = agent
    render(<WorkNeedsYouSection />)
    expect(screen.getByText('Which colour should this rental use?')).toBeTruthy()
    expect(screen.getByText(/Can’t verify this question with its computer/)).toBeTruthy()
    expect(document.querySelector('[data-needs-you-owner-question]')).toBeTruthy()
    expect(document.querySelector('[data-needs-you-unreachable]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Green|Blue/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(mocks.open).toHaveBeenCalledWith(mocks.sessions[0])
    expect(mocks.nativeSend).not.toHaveBeenCalled()
    expect(mocks.sendAnswer).not.toHaveBeenCalled()
  }
)

it('keeps a cached paired question display-only through a later owner update', () => {
  const view = render(<WorkNeedsYouSection />)
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  mocks.state.agentStatusByPaneKey[PANE] = {
    ...mocks.state.agentStatusByPaneKey[PANE],
    stateStartedAt: 2_000,
    interactivePrompt: JSON.stringify({
      questions: [
        {
          question: 'A replacement question?',
          multiSelect: false,
          options: [{ label: 'New option' }]
        }
      ]
    })
  }
  view.rerender(<WorkNeedsYouSection />)
  expect(screen.getByText('A replacement question?')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'New option' })).toBeNull()
  expect(mocks.nativeSend).not.toHaveBeenCalled()
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
})

it('keeps local native questions in the local Decisions queue without a second card', () => {
  mocks.sessions[0]!.hostId = 'local'
  mocks.state.terminalLayoutsByTabId[TAB]!.ptyIdsByLeafId[LEAF] = 'local-pty'
  render(<WorkNeedsYouSection />)
  expect(screen.getByText('Local decision queue')).toBeTruthy()
  expect(screen.queryByText('Which colour should this rental use?')).toBeNull()
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
})

it('keeps unverified paired asynchronous Codex questions on the owner fallback', () => {
  mocks.state.agentStatusByPaneKey[PANE] = {
    ...mocks.state.agentStatusByPaneKey[PANE],
    state: 'done',
    agentType: 'codex',
    interactivePrompt: JSON.stringify({
      delivery: 'async',
      asyncQuestions: [
        { question: 'Choose the rental colour?', multiSelect: false, options: [{ label: 'Blue' }] }
      ]
    })
  }
  render(<WorkNeedsYouSection />)
  expect(screen.getByText('Choose the rental colour?')).toBeTruthy()
  expect(document.querySelector('[data-needs-you-owner-question]')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Blue/ })).toBeNull()
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
})

it('removes the answer card when the mirrored question is answered elsewhere', () => {
  const view = render(<WorkNeedsYouSection />)
  mocks.state.agentStatusByPaneKey[PANE] = {
    ...mocks.state.agentStatusByPaneKey[PANE],
    state: 'working',
    interactivePrompt: undefined
  }
  mocks.panes = []
  view.rerender(<WorkNeedsYouSection />)
  expect(screen.queryByText('Which colour should this rental use?')).toBeNull()
  expect(mocks.sendAnswer).not.toHaveBeenCalled()
})

it.each(['disconnected', 'unverifiable'] as const)(
  'retains an %s question for viewing without offering an answer action',
  (condition) => {
    if (condition === 'disconnected') {
      mocks.state.runtimeStatusByEnvironmentId.set(ENV, { status: null })
    } else {
      mocks.panes[0]!.activityUnverifiable = true
    }
    render(<WorkNeedsYouSection />)
    expect(screen.getByText('Which colour should this rental use?')).toBeTruthy()
    expect(document.querySelector('[data-needs-you-unreachable]')).toBeTruthy()
    expect(document.querySelector('[data-needs-you-owner-question]')).toBeNull()
    expect(mocks.nativeSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(mocks.sendAnswer).not.toHaveBeenCalled()
  }
)
