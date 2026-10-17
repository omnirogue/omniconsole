import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { sessionPullRequestMentions, sessionPullRequestRefs } from './session-pull-request-refs'

function message(role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id: text, role, source: 'transcript', timestamp: 1, blocks: [{ type: 'text', text }] }
}

function toolOutput(output: string): NativeChatMessage {
  return {
    id: output,
    role: 'tool',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'tool-result', output }]
  }
}

const url = (number: number): string => `https://github.com/omnirogue/omnirogue/pull/${number}`

describe('sessionPullRequestRefs', () => {
  it('takes the PRs the AI named in its replies, newest first and once each', () => {
    const refs = sessionPullRequestRefs([
      message('assistant', `Opened ${url(1002)} and ${url(1003)}.`),
      message('user', `What about ${url(900)}?`),
      toolOutput(`${url(1)}\n${url(2)}\n${url(3)}`),
      message('assistant', `Fixed ${url(1003)}; new ${url(1007)}`)
    ])
    expect(refs.map((ref) => ref.number)).toEqual([1007, 1003, 1002])
    expect(refs[0]).toEqual({ owner: 'omnirogue', repo: 'omnirogue', number: 1007 })
  })

  it('stops at the limit', () => {
    const many = Array.from({ length: 9 }, (_, index) => message('assistant', url(index + 1)))
    expect(sessionPullRequestRefs(many, 6).map((ref) => ref.number)).toEqual([9, 8, 7, 6, 5, 4])
  })

  it('remembers when each PR was first named, in the order they were first named', () => {
    const later: NativeChatMessage = { ...message('assistant', `Next ${url(1008)}`), timestamp: 50 }
    const mentions = sessionPullRequestMentions([
      { ...message('assistant', `Opened ${url(1007)}`), timestamp: 10 },
      later,
      { ...message('assistant', `Still on ${url(1007)}`), timestamp: 90 }
    ])
    expect(mentions.map((mention) => [mention.number, mention.firstAt])).toEqual([
      [1007, 10],
      [1008, 50]
    ])
  })
})
