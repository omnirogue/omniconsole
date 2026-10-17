// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY, type ComposerAutocomplete } from './native-chat-composer-state'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:clear',
  name: 'clear',
  description: 'Clear history',
  skillCollision: false
}

function picker(items = [COMMAND]): Extract<ComposerAutocomplete, { mode: 'slash' }> {
  return {
    mode: 'slash',
    query: '',
    items,
    triggerKey: '/:0',
    prefix: '/',
    grouped: false,
    commandsEnabled: true,
    skillsEnabled: false,
    skillStatus: 'ready'
  }
}

function setup(autocomplete: ComposerAutocomplete = picker(), composing = false) {
  const callbacks = {
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: vi.fn(),
    send: vi.fn(),
    sendNow: vi.fn(),
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setHistory: vi.fn()
  }
  const hook = renderHook(() =>
    useNativeChatComposerKeyDown({
      autocomplete,
      activeSuggestion: 0,
      draft: '/',
      history: EMPTY_HISTORY,
      isComposing: () => composing,
      ...callbacks
    })
  )
  return { handler: hook.result.current, callbacks }
}

function keyEvent(key: string, isComposing = false) {
  return {
    key,
    shiftKey: false,
    keyCode: isComposing ? 229 : 0,
    nativeEvent: { isComposing },
    preventDefault: vi.fn()
  }
}

describe('useNativeChatComposerKeyDown', () => {
  it('dispatches command Enter but completes command Tab', () => {
    const enter = setup()
    enter.handler(keyEvent('Enter') as never)
    expect(enter.callbacks.dispatchPickerCommand).toHaveBeenCalledWith(COMMAND)
    expect(enter.callbacks.completePickerItem).not.toHaveBeenCalled()

    const tab = setup()
    tab.handler(keyEvent('Tab') as never)
    expect(tab.callbacks.completePickerItem).toHaveBeenCalledWith(COMMAND)
    expect(tab.callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
  })

  it('falls through to composer send when the open picker has no options', () => {
    const { handler, callbacks } = setup(picker([]))
    handler(keyEvent('Enter') as never)
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it('dismisses Escape without interrupting the agent', () => {
    const { handler, callbacks } = setup()
    handler(keyEvent('Escape') as never)
    expect(callbacks.dismissPicker).toHaveBeenCalledWith('/:0')
    expect(callbacks.interrupt).not.toHaveBeenCalled()
  })

  it('sends now on ⌥Enter and queues-or-sends on plain Enter (brief 78 #7)', () => {
    const { handler, callbacks } = setup(picker([]))
    handler({ ...keyEvent('Enter'), altKey: true } as never)
    expect(callbacks.sendNow).toHaveBeenCalledOnce()
    expect(callbacks.send).not.toHaveBeenCalled()
    handler(keyEvent('Enter') as never)
    expect(callbacks.send).toHaveBeenCalledOnce()
    // Shift+Enter stays a newline whatever else is held.
    handler({ ...keyEvent('Enter'), shiftKey: true, altKey: true } as never)
    expect(callbacks.sendNow).toHaveBeenCalledOnce()
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it('does not accept or submit while IME composition is active', () => {
    const { handler, callbacks } = setup(picker(), true)
    const event = keyEvent('Enter', true)
    handler(event as never)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
  })
})
