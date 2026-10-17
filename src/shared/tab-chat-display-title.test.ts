import { describe, expect, it } from 'vitest'
import { resolveTabDisplayTitle } from './tab-chat-display-title'

describe('resolveTabDisplayTitle', () => {
  it('shows the chat fallback when a chat tab still has the terminal-creation placeholder', () => {
    expect(
      resolveTabDisplayTitle({
        resolvedTitle: 'Terminal 3',
        viewMode: 'chat',
        isPlaceholderTitle: true,
        chatFallbackTitle: 'Claude conversation'
      })
    ).toBe('Claude conversation')
  })

  it('leaves a plain terminal tab title unchanged, even if it is the placeholder', () => {
    expect(
      resolveTabDisplayTitle({
        resolvedTitle: 'Terminal 3',
        viewMode: 'terminal',
        isPlaceholderTitle: true,
        chatFallbackTitle: 'Claude conversation'
      })
    ).toBe('Terminal 3')
  })

  it('leaves an undefined view mode (plain terminal tabs have none) unchanged', () => {
    expect(
      resolveTabDisplayTitle({
        resolvedTitle: 'Terminal 3',
        viewMode: undefined,
        isPlaceholderTitle: true,
        chatFallbackTitle: 'Claude conversation'
      })
    ).toBe('Terminal 3')
  })

  it('keeps a real, already-resolved chat title as-is', () => {
    expect(
      resolveTabDisplayTitle({
        resolvedTitle: 'Fix intake flow',
        viewMode: 'chat',
        isPlaceholderTitle: false,
        chatFallbackTitle: 'Claude conversation'
      })
    ).toBe('Fix intake flow')
  })
})
