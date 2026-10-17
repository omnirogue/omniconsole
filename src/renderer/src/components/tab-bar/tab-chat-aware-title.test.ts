import { describe, expect, it } from 'vitest'
import { resolveChatAwareTabTitle } from './tab-chat-aware-title'

describe('resolveChatAwareTabTitle', () => {
  it('swaps the terminal-creation placeholder for a conversation name in chat mode', () => {
    expect(resolveChatAwareTabTitle('Terminal 3', 'chat', 'claude')).toBe('Claude conversation')
  })

  it('leaves a plain terminal tab title unchanged, even if it is the placeholder', () => {
    expect(resolveChatAwareTabTitle('Terminal 3', 'terminal', 'claude')).toBe('Terminal 3')
  })

  it('keeps a real chat title as-is', () => {
    expect(resolveChatAwareTabTitle('Fix intake flow', 'chat', 'claude')).toBe('Fix intake flow')
  })

  it('falls back to a neutral agent name when no agent is known', () => {
    expect(resolveChatAwareTabTitle('Terminal 1', 'chat', null)).toBe('Agent conversation')
  })
})
