/**
 * The tray reads the same decoded transcript the chat view renders, so a Claude or Codex reply
 * decoded from its own JSONL must yield the agent's suggested next steps.
 */
import { expect, it } from 'vitest'
import { currentParsedNextStepSuggestions } from '../../shared/native-chat-next-action'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

const titles = (message: ReturnType<typeof decodeCodexTranscriptLine>): string[] =>
  currentParsedNextStepSuggestions(message ? [message] : [])?.suggestions.map(
    (suggestion) => suggestion.title
  ) ?? []

it('reads a Codex rollout agent message that ends with "If you want, I can:"', () => {
  const line = JSON.stringify({
    timestamp: '2026-09-23T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message:
        'Fixed the loader and ran the focused tests.\n\nIf you want, I can:\n- add tests for the empty case\n- open a PR'
    }
  })
  expect(titles(decodeCodexTranscriptLine(line, 'codex-1'))).toEqual([
    'Add tests for the empty case',
    'Open a PR'
  ])
})

it('reads a Claude transcript reply with a Next steps heading and a closing offer', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'claude-1',
    timestamp: '2026-09-23T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Done.\n\n## Next steps\n1. Update the changelog\n\nWant me to open a PR for this?'
        }
      ]
    }
  })
  expect(titles(decodeClaudeTranscriptLine(line, 'claude-1'))).toEqual([
    'Update the changelog',
    'Open a PR for this'
  ])
})
