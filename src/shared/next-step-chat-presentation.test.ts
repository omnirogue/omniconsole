import { expect, it } from 'vitest'
import { normalizePromptField } from './agent-status-field-normalization'
import { normalizeNativeChatUserText } from './native-chat-image-transcript-markers'
import { presentNextStepChatMessages } from './next-step-chat-presentation'
import { legacyNextStepChatEnvelope } from './__fixtures__/legacy-next-step-chat-envelope'
import type { NativeChatMessage } from './native-chat-types'

it('shows the typed request of a legacy envelope in status, chat and optimistic reconciliation', () => {
  const sourcePrompt = 'When done, add a Codex reviewer and mark this complete.'
  const submitted = legacyNextStepChatEnvelope(sourcePrompt, { cli: 'omni' })
  expect(normalizePromptField(submitted)).toBe(sourcePrompt)
  expect(normalizeNativeChatUserText(`\u0015${submitted}`)).toBe(sourcePrompt)
  const user: NativeChatMessage = {
    id: 'user-1',
    role: 'user',
    source: 'transcript',
    timestamp: null,
    blocks: [{ type: 'text', text: submitted }]
  }
  const assistant = { ...user, id: 'assistant-1', role: 'assistant' as const }
  const presented = presentNextStepChatMessages([user, assistant])
  expect(presented[0]?.blocks).toEqual([{ type: 'text', text: sourcePrompt }])
  expect(presented[1]).toBe(assistant)
  expect(user.blocks).toEqual([{ type: 'text', text: submitted }])
})

it('preserves history identity when no generated user frame changes', () => {
  const messages: NativeChatMessage[] = [
    {
      id: 'user-1',
      role: 'user',
      source: 'transcript',
      timestamp: null,
      blocks: [{ type: 'text', text: 'Explain this code.' }]
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      source: 'transcript',
      timestamp: null,
      blocks: [{ type: 'text', text: 'The function reads a file.' }]
    }
  ]
  expect(presentNextStepChatMessages(messages)).toBe(messages)
})
