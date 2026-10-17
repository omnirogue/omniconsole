import { describe, expect, it } from 'vitest'
import { describeNativeChatHistoryError } from './native-chat-history-error-copy'

describe('describeNativeChatHistoryError', () => {
  it('rewrites internal history terms, keeping sentence casing', () => {
    expect(describeNativeChatHistoryError('Transcript not found: recording is missing')).toBe(
      'Conversation history not found: conversation history is missing'
    )
    expect(describeNativeChatHistoryError('No TRANSCRIPTS or Recordings on disk')).toBe(
      'No Conversation history or Conversation history on disk'
    )
  })

  it('leaves unrelated text and file paths alone', () => {
    expect(describeNativeChatHistoryError('ENOENT: /tmp/session.jsonl')).toBe(
      'ENOENT: /tmp/session.jsonl'
    )
    expect(describeNativeChatHistoryError('transcription failed')).toBe('transcription failed')
  })
})
