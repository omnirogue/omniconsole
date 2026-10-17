// Vendored from OmniRogue's packages/shared/src/rooms/mentions.test.ts at commit a11b2415c
// (branch feat/rooms-mentions-ui-0913, repo omnirogue/omnirogue); import path adapted to this repo's layout.
import { describe, expect, it } from 'vitest'
import {
  MAX_AGENT_MENTIONS,
  MAX_MESSAGE_CONTENT,
  NO_MENTIONS,
  insertMention,
  mentionCandidates,
  mentionKey,
  mentionKeydown,
  mentionLabel,
  mentionQuery,
  mentionRoster,
  mentionSendPayload,
  mentionToken,
  parseMentions,
  pruneMentions,
  renderContent,
  type ContentSegment,
  type Mention,
  type MentionRegistry,
  type MentionRoster
} from './room-mentions'

const agent = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`
const user = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`
const roster: MentionRoster = {
  agents: [
    { id: agent(1), name: 'Research bot' },
    { id: agent(2), name: 'Planner' }
  ],
  members: [
    { userId: user(1), name: 'Ada Lovelace' },
    { userId: user(2), name: 'Sal' }
  ]
}
const token = (kind: 'agent' | 'user', id: string, label: string) =>
  mentionToken({ kind, id, label })
/** The registry the picker would have built for these chips. */
const picked = (...chosen: Mention[]): MentionRegistry => new Set(chosen.map(mentionKey))
const pick = (kind: 'agent' | 'user', id: string, label: string): Mention => ({ kind, id, label })
/** Every chip in the roster, as if each had been chosen from the picker. */
const allPicked = (from: MentionRoster = roster) => new Set(mentionRoster(from).map(mentionKey))
const texts = (segments: ContentSegment[]) =>
  segments.map((s) => ('text' in s ? s.text : `<${s.mention.kind}:${s.mention.label}>`)).join('')
const mentions = (segments: ContentSegment[]) =>
  segments.flatMap((s) => ('mention' in s ? [s.mention] : []))

describe('parseMentions', () => {
  it('collects ids and strips tokens to readable text', () => {
    const draft = `Morning ${token('user', user(1), 'Ada Lovelace')} — ask ${token('agent', agent(1), 'Research bot')} please`
    const parsed = parseMentions(draft, roster, allPicked())
    expect(parsed.text).toBe('Morning @Ada Lovelace — ask @Research bot please')
    expect(parsed.agentIds).toEqual([agent(1)])
    expect(parsed.userIds).toEqual([user(1)])
    expect(parsed.agentsTruncated).toBe(false)
    expect(parsed.spans.map((s) => [s.kind, s.id, s.label])).toEqual([
      ['user', user(1), 'Ada Lovelace'],
      ['agent', agent(1), 'Research bot']
    ])
    // Spans index the readable text, not the draft.
    const first = parsed.spans[0]!
    expect(parsed.text.slice(first.start, first.end)).toBe('@Ada Lovelace')
  })

  it('treats a typed @Name that was never picked as plain text', () => {
    const parsed = parseMentions('thanks @Ada Lovelace and @Research bot', roster, allPicked())
    expect(parsed.text).toBe('thanks @Ada Lovelace and @Research bot')
    expect(parsed.agentIds).toEqual([])
    expect(parsed.userIds).toEqual([])
    expect(parsed.spans).toEqual([])
  })

  it('collapses duplicate mentions of the same id', () => {
    const chip = token('agent', agent(1), 'Research bot')
    const parsed = parseMentions(
      `${chip} ${chip} and ${token('user', user(2), 'Sal')} ${token('user', user(2), 'Sal')}`,
      roster,
      allPicked()
    )
    expect(parsed.agentIds).toEqual([agent(1)])
    expect(parsed.userIds).toEqual([user(2)])
    expect(parsed.spans).toHaveLength(4)
    expect(parsed.agentsTruncated).toBe(false)
  })

  it('caps agents at the server limit of five and reports the truncation', () => {
    const many: MentionRoster = {
      agents: Array.from({ length: 7 }, (_, i) => ({ id: agent(i), name: `Bot ${i}` }))
    }
    const draft = many
      .agents!.map((a) => mentionToken({ kind: 'agent', id: a.id, label: a.name }))
      .join(' ')
    const parsed = parseMentions(draft, many, allPicked(many))
    expect(MAX_AGENT_MENTIONS).toBe(5)
    expect(parsed.agentIds).toEqual([agent(0), agent(1), agent(2), agent(3), agent(4)])
    expect(parsed.agentsTruncated).toBe(true)
    // Every mention still reads in the text that goes out.
    expect(parsed.text).toBe('@Bot 0 @Bot 1 @Bot 2 @Bot 3 @Bot 4 @Bot 5 @Bot 6')
  })

  it('does not count a repeated sixth agent as six distinct agents', () => {
    const many: MentionRoster = {
      agents: Array.from({ length: 6 }, (_, i) => ({ id: agent(i), name: `Bot ${i}` }))
    }
    const draft = [...many.agents!.slice(0, 5), many.agents![5]!, many.agents![5]!]
      .map((a) => mentionToken({ kind: 'agent', id: a.id, label: a.name }))
      .join(' ')
    expect(parseMentions(draft, many, allPicked(many)).agentIds).toHaveLength(5)
    expect(parseMentions(draft, many, allPicked(many)).agentsTruncated).toBe(true)
  })

  it('strips a token whose id has left the room but never sends the raw token', () => {
    const parsed = parseMentions(
      `bye ${token('agent', agent(9), 'Ghost bot')}`,
      roster,
      allPicked()
    )
    expect(parsed.text).toBe('bye @Ghost bot')
    expect(parsed.agentIds).toEqual([])
    expect(parsed.spans).toEqual([])
  })

  it('round-trips a label containing @ and ]', () => {
    const label = 'Q] team @ops'
    const chip = token('user', user(1), label)
    expect(chip).toBe(`@[Q\\] team @ops](user:${user(1)})`)
    const parsed = parseMentions(
      `hi ${chip}!`,
      { members: [{ userId: user(1), name: label }] },
      picked(pick('user', user(1), label))
    )
    expect(parsed.text).toBe('hi @Q] team @ops!')
    expect(parsed.userIds).toEqual([user(1)])
    expect(parsed.spans[0]!.label).toBe(label)
  })

  it('normalises and caps a label at 60 characters', () => {
    expect(mentionLabel('  Ada   \n Lovelace  ')).toBe('Ada Lovelace')
    expect(mentionLabel('x'.repeat(90))).toHaveLength(60)
  })
})

describe('mentionQuery', () => {
  it('finds the query at the caret', () => {
    expect(mentionQuery('hey @res', 8)).toEqual({ query: 'res', start: 4, end: 8 })
    expect(mentionQuery('@', 1)).toEqual({ query: '', start: 0, end: 1 })
    expect(mentionQuery('hey @Ada Love', 13)!.query).toBe('Ada Love')
  })

  it('returns null where no mention is being typed', () => {
    expect(mentionQuery('hello there', 5)).toBeNull()
    expect(mentionQuery('mail sal@example.com', 12)).toBeNull()
    expect(mentionQuery('@res\nsecond line', 16)).toBeNull()
    expect(mentionQuery(`@${'x'.repeat(70)}`, 71)).toBeNull()
  })

  it('never re-opens inside or after a finished chip', () => {
    const chip = token('agent', agent(1), 'Research bot')
    expect(mentionQuery(chip, chip.length)).toBeNull()
    expect(mentionQuery(chip, 4)).toBeNull()
    expect(mentionQuery(`${chip} hello`, chip.length + 6)).toBeNull()
    // A fresh @ after a chip still opens the picker.
    expect(mentionQuery(`${chip} @pl`, chip.length + 4)!.query).toBe('pl')
  })

  it('clamps a caret outside the text', () => {
    expect(mentionQuery('hey @res', 999)).toEqual({ query: 'res', start: 4, end: 8 })
    expect(mentionQuery('hey @res', -3)).toBeNull()
  })
})

describe('mentionCandidates and insertMention', () => {
  it('lists agents then people and ranks prefix matches first', () => {
    expect(mentionCandidates(roster, '').map((c) => c.label)).toEqual([
      'Research bot',
      'Planner',
      'Ada Lovelace',
      'Sal'
    ])
    expect(mentionCandidates(roster, 'bot').map((c) => [c.kind, c.label])).toEqual([
      ['agent', 'Research bot']
    ])
    expect(mentionCandidates(roster, 'a').map((c) => c.label)).toEqual([
      'Ada Lovelace',
      'Research bot',
      'Planner',
      'Sal'
    ])
    expect(mentionCandidates(roster, 'nobody')).toEqual([])
    expect(mentionCandidates(roster, '', 2)).toHaveLength(2)
  })

  it('replaces the query range with a chip and reports the caret', () => {
    const range = mentionQuery('hey @res', 8)!
    const result = insertMention('hey @res', range, {
      kind: 'agent',
      id: agent(1),
      label: 'Research bot'
    })
    expect(result.text).toBe(`hey ${token('agent', agent(1), 'Research bot')} `)
    expect(result.caret).toBe(result.text.length)
    expect(parseMentions(result.text, roster, result.registry).agentIds).toEqual([agent(1)])
  })
})

describe('mentionSendPayload', () => {
  it('sends readable content plus the mentioned agent ids, never a token', () => {
    const draft = `  ${token('agent', agent(1), 'Research bot')} take a look for ${token('user', user(1), 'Ada Lovelace')}  `
    const payload = mentionSendPayload(draft, roster, allPicked())
    expect(payload).toEqual({
      content: '@Research bot take a look for @Ada Lovelace',
      targetAgentIds: [agent(1)],
      userIds: [user(1)],
      overLimit: false,
      tooLong: false
    })
    expect(payload.content).not.toContain('](')
  })

  it('merges the compose select as a fallback and deduplicates it', () => {
    expect(mentionSendPayload('hello', roster, NO_MENTIONS, agent(2)).targetAgentIds).toEqual([
      agent(2)
    ])
    const draft = token('agent', agent(1), 'Research bot')
    expect(mentionSendPayload(draft, roster, allPicked(), agent(2)).targetAgentIds).toEqual([
      agent(1),
      agent(2)
    ])
    expect(mentionSendPayload(draft, roster, allPicked(), agent(1)).targetAgentIds).toEqual([
      agent(1)
    ])
  })

  it('drops a select id that is no longer attached to the room', () => {
    expect(mentionSendPayload('hello', roster, NO_MENTIONS, agent(7)).targetAgentIds).toEqual([])
  })

  it('flags a draft over the agent cap instead of silently dropping a target', () => {
    const many: MentionRoster = {
      agents: Array.from({ length: 6 }, (_, i) => ({ id: agent(i), name: `Bot ${i}` }))
    }
    const five = many
      .agents!.slice(0, 5)
      .map((a) => mentionToken({ kind: 'agent', id: a.id, label: a.name }))
      .join(' ')
    expect(mentionSendPayload(five, many, allPicked(many)).overLimit).toBe(false)
    expect(mentionSendPayload(five, many, allPicked(many), agent(5)).overLimit).toBe(true)
    expect(
      mentionSendPayload(
        `${five} ${mentionToken({ kind: 'agent', id: agent(5), label: 'Bot 5' })}`,
        many,
        allPicked(many)
      ).overLimit
    ).toBe(true)
  })

  it('reports empty content for a draft with nothing to say', () => {
    expect(mentionSendPayload('   ', roster, NO_MENTIONS).content).toBe('')
  })
})

// The one invariant the wire body must hold: nothing token-shaped survives.
const TOKEN_SHAPE = /@\[(?:[^\\\]\n]|\\[\\\]])*\]\((?:agent|user):[A-Za-z0-9_-]{1,64}\)/

describe('picker provenance (a token only routes if the picker wrote it)', () => {
  it('ignores a hand-typed token that borrows one id and another entry label', () => {
    // The exact reviewer input: Research bot's words, Planner's id.
    const forged = `@[Research bot](agent:${agent(2)})`
    const parsed = parseMentions(forged, roster, allPicked())
    expect(parsed.agentIds).toEqual([])
    expect(parsed.spans).toEqual([])
    expect(parsed.text).toBe('@Research bot')
    expect(mentionSendPayload(forged, roster, allPicked()).targetAgentIds).toEqual([])
  })

  it('ignores a well-formed token for a roster entry nobody picked', () => {
    const chip = token('agent', agent(1), 'Research bot')
    expect(parseMentions(chip, roster, NO_MENTIONS).agentIds).toEqual([])
    expect(
      parseMentions(chip, roster, picked(pick('user', user(1), 'Ada Lovelace'))).agentIds
    ).toEqual([])
    // Same text, once the picker has actually inserted it.
    expect(
      parseMentions(chip, roster, picked(pick('agent', agent(1), 'Research bot'))).agentIds
    ).toEqual([agent(1)])
  })

  it('defaults to trusting nothing when no registry is supplied', () => {
    expect(parseMentions(token('agent', agent(1), 'Research bot'), roster).agentIds).toEqual([])
  })

  it('registers the picker choice on insert so the chip it wrote is trusted', () => {
    const range = mentionQuery('hey @res', 8)!
    const first = insertMention('hey @res', range, pick('agent', agent(1), 'Research bot'))
    expect([...first.registry]).toEqual([`agent:${agent(1)}:Research bot`])
    const second = insertMention(
      `${first.text}@pla`,
      { start: first.text.length, end: first.text.length + 4 },
      pick('agent', agent(2), 'Planner'),
      first.registry
    )
    expect(mentionSendPayload(second.text, roster, second.registry).targetAgentIds).toEqual([
      agent(1),
      agent(2)
    ])
    // The earlier choice is not lost when a second chip is added.
    expect(second.registry.size).toBe(2)
  })
})

describe('a registry never outlives its draft', () => {
  const chip = token('agent', agent(1), 'Research bot')
  const registry = picked(pick('agent', agent(1), 'Research bot'))

  it('prunes to nothing when the draft is emptied', () => {
    // The shape of the bug behind the confirmation path: the compose box is
    // cleared, and whatever the old draft registered must not survive it.
    expect([...pruneMentions('', registry)]).toEqual([])
    expect([...pruneMentions('a fresh message', registry)]).toEqual([])
    expect(parseMentions(chip, roster, pruneMentions('', registry)).agentIds).toEqual([])
  })

  it('keeps a chip that is still in the draft', () => {
    expect(pruneMentions(`hi ${chip} there`, registry)).toBe(registry)
    expect([
      ...pruneMentions(`${chip} ${token('user', user(1), 'Ada Lovelace')}`, registry)
    ]).toEqual([...registry])
  })

  it('revokes a chip whose text was edited, including its label', () => {
    expect([...pruneMentions(`@[Research bo](agent:${agent(1)})`, registry)]).toEqual([])
    expect([...pruneMentions(`@[Research bot](agent:${agent(2)})`, registry)]).toEqual([])
    // …so retyping the token by hand afterwards addresses nobody.
    expect(parseMentions(chip, roster, pruneMentions('gone', registry)).agentIds).toEqual([])
  })

  it('drops only the keys whose chips went away', () => {
    const both = picked(
      pick('agent', agent(1), 'Research bot'),
      pick('user', user(1), 'Ada Lovelace')
    )
    const left = pruneMentions(chip, both)
    expect([...left]).toEqual([`agent:${agent(1)}:Research bot`])
    expect(
      parseMentions(`${chip} ${token('user', user(1), 'Ada Lovelace')}`, roster, left).userIds
    ).toEqual([])
  })

  it('is a no-op on an empty registry', () => {
    expect(pruneMentions('anything', NO_MENTIONS)).toBe(NO_MENTIONS)
  })
})

describe('no token shape reaches the wire', () => {
  it('strips a hand-typed token whose label is longer than any display name', () => {
    const forged = `@[${'y'.repeat(61)}](agent:${agent(1)})`
    const parsed = parseMentions(forged, roster, allPicked())
    expect(parsed.agentIds).toEqual([])
    expect(parsed.text).toBe(`@${'y'.repeat(61)}`)
    expect(TOKEN_SHAPE.test(parsed.text)).toBe(false)
  })

  it('never offers a display name that is itself the token grammar', () => {
    const trap = `@[x](agent:${agent(1)})`
    const hostile: MentionRoster = {
      agents: roster.agents,
      members: [
        { userId: user(3), name: trap },
        { userId: user(1), name: 'Ada Lovelace' }
      ]
    }
    expect(mentionRoster(hostile).map((entry) => entry.label)).toEqual([
      'Research bot',
      'Planner',
      'Ada Lovelace'
    ])
    expect(mentionCandidates(hostile, '').some((entry) => entry.id === user(3))).toBe(false)
  })

  it('breaks a shape spliced out of a chip label and the text after it', () => {
    // A label ending in "@" next to "[x](agent:…)" would otherwise read as a token.
    const odd: MentionRoster = {
      agents: roster.agents,
      members: [{ userId: user(1), name: 'hi@' }]
    }
    const draft = `${token('user', user(1), 'hi@')}[x](agent:${agent(1)})`
    const parsed = parseMentions(draft, odd, picked(pick('user', user(1), 'hi@')))
    expect(TOKEN_SHAPE.test(parsed.text)).toBe(false)
    expect(parsed.text).toBe(`@hi@ [x](agent:${agent(1)})`)
    // The real mention survives, and its offsets still frame it.
    expect(parsed.userIds).toEqual([user(1)])
    expect(parsed.text.slice(parsed.spans[0]!.start, parsed.spans[0]!.end)).toBe('@hi@')
  })

  it('holds the invariant across every draft these tests build', () => {
    for (const draft of [
      `${token('agent', agent(1), 'Research bot')} hi`,
      `@[${'y'.repeat(61)}](agent:${agent(1)})`,
      `@[Research bot](agent:${agent(2)})`,
      `@[a](user:${user(1)})@[b](agent:${agent(1)})`,
      'plain @Ada Lovelace text'
    ]) {
      expect(TOKEN_SHAPE.test(parseMentions(draft, roster, allPicked()).text)).toBe(false)
    }
  })
})

describe('message length (the picker inserts past the textarea maxLength)', () => {
  it('flags the insertion that pushes a full draft over the server cap', () => {
    const base = `${'x'.repeat(2998)} @`
    const range = mentionQuery(base, base.length)!
    const inserted = insertMention(base, range, pick('agent', agent(2), 'Planner'))
    const payload = mentionSendPayload(inserted.text, roster, inserted.registry)
    expect(payload.content.length).toBe(3007)
    expect(payload.tooLong).toBe(true)
    // The mention itself is still correct; only the length is refused.
    expect(payload.targetAgentIds).toEqual([agent(2)])
  })

  it('measures the readable content, not the draft with its tokens', () => {
    const chip = token('agent', agent(1), 'Research bot')
    const draft = chip + 'x'.repeat(2960)
    expect(draft.length).toBeGreaterThan(MAX_MESSAGE_CONTENT)
    expect(mentionSendPayload(draft, roster, allPicked()).tooLong).toBe(false)
  })

  it('draws the line exactly at the server cap', () => {
    expect(MAX_MESSAGE_CONTENT).toBe(3000)
    expect(mentionSendPayload('x'.repeat(3000), roster, NO_MENTIONS).tooLong).toBe(false)
    expect(mentionSendPayload('x'.repeat(3001), roster, NO_MENTIONS).tooLong).toBe(true)
  })
})

describe('mentionKeydown', () => {
  const open = { options: 3, index: 0, composing: false }
  it('navigates, chooses and dismisses while the picker is open', () => {
    expect(mentionKeydown({ key: 'ArrowDown' }, open)).toEqual({ type: 'move', index: 1 })
    expect(mentionKeydown({ key: 'ArrowUp' }, open)).toEqual({ type: 'move', index: 2 })
    expect(mentionKeydown({ key: 'Enter' }, { ...open, index: 2 })).toEqual({
      type: 'choose',
      index: 2
    })
    expect(mentionKeydown({ key: 'Tab' }, open)).toEqual({ type: 'choose', index: 0 })
    expect(mentionKeydown({ key: 'Escape' }, open)).toEqual({ type: 'dismiss' })
  })

  it('yields every key to an open IME composition', () => {
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
      expect(mentionKeydown({ key, isComposing: true }, open)).toBeNull()
      expect(mentionKeydown({ key }, { ...open, composing: true })).toBeNull()
    }
  })

  it('leaves the keystroke alone when the picker is closed or the key is ordinary', () => {
    expect(mentionKeydown({ key: 'Enter' }, { options: 0, index: 0 })).toBeNull()
    expect(mentionKeydown({ key: 'a' }, open)).toBeNull()
    expect(mentionKeydown({ key: 'Backspace' }, open)).toBeNull()
  })

  it('yields the Enter that confirms an IME candidate after compositionend', () => {
    // Browsers fire compositionend BEFORE that keydown, so the view's own
    // `composing` flag is already false and isComposing is false too: keyCode
    // 229 is the only thing left that says the keystroke belongs to the IME.
    const afterCompositionEnd = { ...open, composing: false }
    expect(
      mentionKeydown({ key: 'Enter', isComposing: false, keyCode: 229 }, afterCompositionEnd)
    ).toBeNull()
    expect(
      mentionKeydown({ key: 'ArrowDown', isComposing: false, keyCode: 229 }, afterCompositionEnd)
    ).toBeNull()
    // The very next Enter, a real one, still picks.
    expect(
      mentionKeydown({ key: 'Enter', isComposing: false, keyCode: 13 }, afterCompositionEnd)
    ).toEqual({ type: 'choose', index: 0 })
  })

  it('clamps a highlight left over from a longer list', () => {
    expect(mentionKeydown({ key: 'Enter' }, { options: 2, index: 9 })).toEqual({
      type: 'choose',
      index: 1
    })
    expect(mentionKeydown({ key: 'ArrowDown' }, { options: 2, index: -3 })).toEqual({
      type: 'move',
      index: 1
    })
  })
})

describe('renderContent', () => {
  it('renders a chip token and leaves an unknown id as readable text', () => {
    const content = `${token('agent', agent(1), 'Research bot')} and ${token('user', user(9), 'Departed')}`
    const segments = renderContent(content, roster)
    expect(texts(segments)).toBe('<agent:Research bot> and @Departed')
    expect(mentions(segments)).toEqual([
      { kind: 'agent', id: agent(1), label: 'Research bot', source: 'token' }
    ])
  })

  it('highlights a plain @Name cosmetically, marked as a name match', () => {
    const segments = renderContent('thanks @Ada Lovelace!', roster)
    expect(texts(segments)).toBe('thanks <user:Ada Lovelace>!')
    expect(mentions(segments)[0]!.source).toBe('name')
  })

  it('prefers the longest roster name and respects word boundaries', () => {
    const overlap: MentionRoster = {
      members: [
        { userId: user(1), name: 'Sal' },
        { userId: user(2), name: 'Sal Baker' }
      ]
    }
    expect(mentions(renderContent('@Sal Baker ships', overlap))[0]!.id).toBe(user(2))
    expect(mentions(renderContent('@Sal ships', overlap))[0]!.id).toBe(user(1))
    expect(renderContent('@Sal ships', overlap)).toEqual([{ text: '@Sal ships' }])
    expect(renderContent('mail sal@Sal today', overlap)).toEqual([{ text: 'mail sal@Sal today' }])
  })

  it('leaves an ambiguous name as text', () => {
    const twins: MentionRoster = {
      members: [
        { userId: user(1), name: 'Sal' },
        { userId: user(2), name: 'sal' }
      ]
    }
    expect(renderContent('hi @Sal', twins)).toEqual([{ text: 'hi @Sal' }])
  })

  it('handles content with no mentions and empty content', () => {
    expect(renderContent('plain message', roster)).toEqual([{ text: 'plain message' }])
    expect(renderContent('', roster)).toEqual([])
    expect(renderContent('a @ b', roster)).toEqual([{ text: 'a @ b' }])
  })

  it('renders what parseMentions sends, so the local echo matches the server copy', () => {
    const draft = `ping ${token('agent', agent(2), 'Planner')} for ${token('user', user(2), 'Sal')}`
    const sent = parseMentions(draft, roster, allPicked()).text
    expect(sent).toBe('ping @Planner for @Sal')
    expect(mentions(renderContent(sent, roster)).map((m) => m.id)).toEqual([agent(2), user(2)])
    expect(mentions(renderContent(draft, roster)).map((m) => m.id)).toEqual([agent(2), user(2)])
  })
})
