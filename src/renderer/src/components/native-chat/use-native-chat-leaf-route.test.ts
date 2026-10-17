import { setNativeChatLeaf, useNativeChatLeafState } from './native-chat-leaf-state'
// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatLeafRoute } from './use-native-chat-leaf-route'

const mocks = vi.hoisted(() => ({ switchView: vi.fn() }))
vi.mock('./switch-native-chat-view', () => ({ switchNativeChatView: mocks.switchView }))

describe('useNativeChatLeafRoute', () => {
  it('exits chat without telemetry: an owning-pane close is a lifecycle event, not a user toggle', () => {
    mocks.switchView.mockClear()
    setNativeChatLeaf('terminal', 'leaf-a')
    const { result } = renderHook(() => useNativeChatLeafRoute('workspace', 'unified', 'terminal'))
    act(() => result.current({ chatLeafId: null, exitChat: true }))
    expect(mocks.switchView).toHaveBeenCalledWith('workspace', 'unified', 'terminal', {
      focus: false,
      emitTelemetry: false
    })
  })

  it('updates the retained leaf without switching modes when chat is not exiting', () => {
    mocks.switchView.mockClear()
    setNativeChatLeaf('terminal', 'leaf-a')
    const { result } = renderHook(() => useNativeChatLeafRoute('workspace', 'unified', 'terminal'))
    act(() => result.current({ chatLeafId: 'leaf-b', exitChat: false }))
    expect(useNativeChatLeafState.getState().nativeChatLeafByTabId.terminal).toBe('leaf-b')
    expect(mocks.switchView).not.toHaveBeenCalled()
  })
})
