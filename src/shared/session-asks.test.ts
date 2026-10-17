import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { askIndexForMessage, sessionAsks, sessionAskTitle } from './session-asks'

let clock = 0
function turn(role: NativeChatMessage['role'], text: string): NativeChatMessage {
  clock += 1
  return {
    id: `m${clock}`,
    role,
    source: 'transcript',
    timestamp: clock,
    blocks: [{ type: 'text', text }]
  }
}
function toolCall(): NativeChatMessage {
  return {
    id: 'call',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'tool-call', name: 'exec_command', input: '{"cmd":"ls"}' }]
  }
}

describe('sessionAskTitle', () => {
  it.each([
    [
      'can you get our unlimited toggle PR ready for deployent on both OmniRogue & Betacorp please: Before publishing, fix BetaCorp',
      'Get our unlimited toggle PR ready for deployent on both OmniRogue & Betacorp'
    ],
    [
      'please refund these two customers and reply to the reviews',
      'Refund these two customers and reply to the reviews'
    ],
    ['Make 5 new ad creatives. Vertical 9:16, three hooks each.', 'Make 5 new ad creatives'],
    ['Hm i think you need to find a unified way', 'You need to find a unified way']
  ])('%s → %s', (prompt, title) => {
    expect(sessionAskTitle(prompt)).toBe(title)
  })

  it('cuts a long ask at a word with an ellipsis', () => {
    const title = sessionAskTitle(`Write ${'a very long brief '.repeat(12)}`)
    expect(title.length).toBeLessThanOrEqual(90)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('sessionAsks', () => {
  it('lists the person’s asks in order, folding replies into the ask before them', () => {
    const asks = sessionAsks([
      turn('user', 'Make 5 new ad creatives for the webinar funnel'),
      turn('assistant', 'Here are five concepts.'),
      turn('user', 'yes'),
      turn('user', 'ok done logged in'),
      turn('assistant', 'Rendering now.'),
      turn('user', 'Now upload them to Drive and push the best two to Meta')
    ])
    expect(asks.map((ask) => [ask.title, ask.replies, ask.answered])).toEqual([
      ['Make 5 new ad creatives for the webinar funnel', 2, true],
      ['Now upload them to Drive and push the best two to Meta', 0, false]
    ])
  })

  it('reads Codex turns: tool messages answer, injected context and duplicate prompts do not ask', () => {
    const prompt = 'can you get the unlimited toggle ready for OmniRogue and BetaCorp'
    const asks = sessionAsks([
      turn('user', '<environment_context>cwd=/x</environment_context>'),
      turn('user', prompt),
      turn('user', prompt),
      toolCall(),
      { ...turn('tool', ''), blocks: [{ type: 'tool-result', output: 'ok' }] }
    ])
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ index: 1, answered: true, replies: 0 })
  })

  it('folds a prompt sent before the AI replied into the ask it is still reading', () => {
    const first = turn('user', 'What about ads, cant we use this on advertising')
    const asks = sessionAsks([
      first,
      {
        ...turn('user', 'To determine which ad within an adset we should keep on'),
        timestamp: first.timestamp! + 20_000
      },
      turn('assistant', 'Yes: rank ads by purchases per dollar.')
    ])
    expect(asks.map((ask) => [ask.title, ask.replies, ask.answered])).toEqual([
      ['What about ads, cant we use this on advertising', 1, true]
    ])
  })

  it('keeps a second ask queued minutes later as its own row', () => {
    const first = turn('user', 'Draft the webinar script for Tuesday')
    const later = {
      ...turn('user', 'Also rebuild the pricing page hero'),
      timestamp: first.timestamp! + 600_000
    }
    expect(sessionAsks([first, later]).map((ask) => ask.title)).toEqual([
      'Draft the webinar script for Tuesday',
      'Rebuild the pricing page hero'
    ])
  })

  it('finds which ask a message belongs to', () => {
    const asks = sessionAsks([
      turn('assistant', 'Hello'),
      turn('user', 'Draft the webinar script for Tuesday'),
      turn('assistant', 'Drafting'),
      turn('user', 'Record the voiceover for the intro section'),
      turn('assistant', 'Recording')
    ])
    expect([0, 1, 2, 3, 4].map((index) => askIndexForMessage(asks, index))).toEqual([
      -1, 0, 0, 1, 1
    ])
  })
})
