// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`
const PROMPT = JSON.stringify({
  ompApproval: { tool: 'bash', toolCallId: 'call-a', summary: 'cp a b' }
})
function initialState(ptyId = 'pty-owned') {
  return {
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        state: 'blocked',
        agentType: 'omp',
        interactivePrompt: PROMPT,
        connectionId: 'owner-a',
        terminalHandle: 'term-owned',
        providerSession: { id: 'native-owned' },
        restoredUnconfirmed: false
      }
    },
    terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_ID]: ptyId } } }
  }
}
const mocks = vi.hoisted(() => ({ write: vi.fn(), state: undefined as unknown }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({ activeRuntimeEnvironmentId: 'owner-a' })
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: vi.fn(),
  sendRuntimePtyInputVerified: mocks.write
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatAskAnswer: vi.fn(),
  sendNativeChatMessage: vi.fn()
}))

import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'

function state() {
  return mocks.state as ReturnType<typeof initialState>
}
function renderSender(targetPtyId: string | null = 'pty-owned') {
  return renderHook(({ ptyId }) => useNativeChatInteractiveSend('tab-1', PANE_KEY, ptyId, 'omp'), {
    initialProps: { ptyId: targetPtyId }
  })
}

describe('native Chat approval ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.state = initialState()
    mocks.write.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each(['pty-owned', 'remote:owner-a@@term-owned'])(
    'uses strict verified writes for %s and retains the captured owner',
    async (ptyId) => {
      mocks.state = initialState(ptyId)
      const { result } = renderSender(ptyId)
      const settled = vi.fn()
      act(() => {
        expect(result.current.sendApproval(PROMPT, 'approve', settled)).toBe(true)
      })
      await vi.runAllTimersAsync()
      expect(mocks.write.mock.calls).toEqual([
        [{ activeRuntimeEnvironmentId: 'owner-a' }, ptyId, '\x1b[A', { requireAcceptance: true }],
        [{ activeRuntimeEnvironmentId: 'owner-a' }, ptyId, '\r', { requireAcceptance: true }]
      ])
      expect(settled).toHaveBeenCalledExactlyOnceWith(true)
    }
  )

  it.each(['request', 'pty', 'host', 'provider session', 'agent', 'state', 'restored status'])(
    'stops before Enter when the %s changes, even before React rerenders',
    async (changed) => {
      const { result } = renderSender()
      const settled = vi.fn()
      act(() => {
        result.current.sendApproval(PROMPT, 'approve', settled)
      })
      await vi.advanceTimersByTimeAsync(0)
      const current = state().agentStatusByPaneKey[PANE_KEY]!
      if (changed === 'request') {
        current.interactivePrompt = PROMPT.replace('call-a', 'call-b')
      }
      if (changed === 'pty') {
        state().terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId[LEAF_ID] = 'other-pty'
      }
      if (changed === 'host') {
        state().agentStatusByPaneKey[PANE_KEY] = { ...current, connectionId: 'owner-b' }
      }
      if (changed === 'provider session') {
        state().agentStatusByPaneKey[PANE_KEY] = {
          ...current,
          providerSession: { id: 'native-other' }
        }
      }
      if (changed === 'agent') {
        current.agentType = 'claude'
      }
      if (changed === 'state') {
        current.state = 'working'
      }
      if (changed === 'restored status') {
        current.restoredUnconfirmed = true
      }
      await vi.runAllTimersAsync()
      expect(mocks.write).toHaveBeenCalledTimes(1)
      expect(settled).toHaveBeenCalledExactlyOnceWith(false)
    }
  )

  it('refuses a duplicate approval while its first delivery is pending', async () => {
    const { result } = renderSender()
    const settled = vi.fn()
    act(() => {
      expect(result.current.sendApproval(PROMPT, 'approve', settled)).toBe(true)
      expect(result.current.sendApproval(PROMPT, 'approve', settled)).toBe(false)
    })
    await vi.runAllTimersAsync()
    expect(mocks.write).toHaveBeenCalledTimes(2)
    expect(settled).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('refuses a stale card, unknown control string, missing PTY, or legacy OMP envelope', async () => {
    const { result } = renderSender()
    expect(
      result.current.sendApproval(PROMPT.replace('call-a', 'call-b'), 'approve', vi.fn())
    ).toBe(false)
    expect(result.current.sendApproval(PROMPT, '1', vi.fn())).toBe(false)
    const legacy = JSON.stringify({ approval: { tool: 'bash' } })
    state().agentStatusByPaneKey[PANE_KEY]!.interactivePrompt = legacy
    expect(result.current.sendApproval(legacy, '1', vi.fn())).toBe(false)
    const missing = renderSender(null)
    expect(missing.result.current.sendApproval(PROMPT, 'approve', vi.fn())).toBe(false)
    await vi.runAllTimersAsync()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('cancels queued approval keys when React rebinds the same view to another PTY', async () => {
    const { result, rerender } = renderSender()
    const settled = vi.fn()
    act(() => {
      result.current.sendApproval(PROMPT, 'approve', settled)
    })
    await vi.advanceTimersByTimeAsync(0)
    rerender({ ptyId: 'other-pty' })
    await vi.runAllTimersAsync()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('verifies legacy Claude approvals through the same guarded delivery path', async () => {
    const legacy = JSON.stringify({ approval: { tool: 'Bash', summary: 'cp a b' } })
    state().agentStatusByPaneKey[PANE_KEY]!.interactivePrompt = legacy
    state().agentStatusByPaneKey[PANE_KEY]!.agentType = 'claude'
    const { result } = renderHook(() =>
      useNativeChatInteractiveSend('tab-1', PANE_KEY, 'pty-owned', 'claude')
    )
    const settled = vi.fn()
    act(() => {
      expect(result.current.sendApproval(legacy, '1', settled)).toBe(true)
    })
    await vi.runAllTimersAsync()
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      { activeRuntimeEnvironmentId: 'owner-a' },
      'pty-owned',
      '1',
      { requireAcceptance: true }
    )
    expect(settled).toHaveBeenCalledExactlyOnceWith(true)
  })
})
