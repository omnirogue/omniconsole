import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  authoredHandoffNote,
  SESSION_HANDOFF_SUMMARY_MAX_CHARS,
  assistantProse,
  buildSessionHandoffRequest,
  buildSessionHandoffSummary,
  conversationWrittenFiles,
  finalAssistantAnswer,
  firstPersonAsk,
  personWords,
  readablePackageFileName
} from './session-handoff-summary'

function message(role: NativeChatMessage['role'], ...texts: string[]): NativeChatMessage {
  return {
    id: `${role}-${texts.join('|')}`,
    role,
    blocks: texts.map((text) => ({ type: 'text' as const, text })),
    timestamp: null,
    source: 'transcript'
  }
}

describe('the summary a person receives', () => {
  it('carries the conversation’s final answer, not the title alone (chain source_066810c9)', () => {
    const summary = buildSessionHandoffSummary({
      stated: '💬 → 👥 review ×2 ↩',
      finalAnswer: 'Three ad angles are drafted in ads.md; angle 2 tested best.'
    })
    expect(summary).toContain('💬 → 👥 review ×2 ↩')
    expect(summary).toContain('## Final answer from the conversation')
    expect(summary).toContain('angle 2 tested best.')
  })

  it('is what the plan stated when no answer could be read, and never says a result twice', () => {
    expect(buildSessionHandoffSummary({ stated: ' Title ', finalAnswer: null })).toBe('Title')
    expect(
      buildSessionHandoffSummary({
        stated: 'Title\n\nThe review passed.',
        finalAnswer: 'The review passed.'
      })
    ).toBe('Title\n\nThe review passed.')
  })

  it('keeps the end of an answer that does not fit, where the conclusion is', () => {
    const summary = buildSessionHandoffSummary({
      stated: 'Title',
      finalAnswer: `${'x'.repeat(SESSION_HANDOFF_SUMMARY_MAX_CHARS)} CONCLUSION`
    })
    expect(summary.length).toBeLessThanOrEqual(SESSION_HANDOFF_SUMMARY_MAX_CHARS)
    expect(summary.endsWith(' CONCLUSION')).toBe(true)
  })
})

describe('the conversation’s final answer', () => {
  it('is the last assistant prose, past trailing tool and user messages', () => {
    const answer = message('assistant', 'Done.', 'See report.md.')
    const found = finalAssistantAnswer([
      message('assistant', 'Working on it.'),
      answer,
      message('tool', 'exit 0'),
      message('assistant', '   '),
      message('user', 'thanks')
    ])
    expect(found).toBe(answer)
    expect(assistantProse(found!)).toBe('Done.\n\nSee report.md.')
    expect(finalAssistantAnswer([message('user', 'hello')])).toBeNull()
  })
})

describe('the title and description a person reads first', () => {
  it('says what was asked and where it ended, not the plan notation (chain source_c7e04b7a)', () => {
    const request = buildSessionHandoffRequest({
      relationship: 'review',
      authoredNote: '',
      asked: 'Write five ad angles for OmniRogue\nand rank them.',
      finalAnswer: 'Five angles are in ads.md; angle 2 ranks first.',
      fallbackTitle: '👥 review ×2 ↩'
    })
    expect(request.title).toBe('Review: Write five ad angles for OmniRogue and rank them.')
    expect(request.description).toContain('Please review this work')
    expect(request.description).toContain('**What was asked**')
    expect(request.description).toContain('angle 2 ranks first.')
  })

  it('leads with the sender’s own words and says a hand off is theirs to own', () => {
    const nothingRead = { asked: null, finalAnswer: null }
    expect(
      buildSessionHandoffRequest({
        relationship: 'handoff',
        authoredNote: 'Ship this by Friday.',
        fallbackTitle: 'Webinar deck',
        ...nothingRead
      })
    ).toEqual({ title: 'Hand off: Webinar deck', description: 'Ship this by Friday.' })
    expect(
      buildSessionHandoffRequest({
        relationship: 'handoff',
        authoredNote: '',
        fallbackTitle: 'x',
        ...nothingRead
      }).description
    ).toContain('you own it from here')
  })

  it('treats a note equal to the plan title as notation unless the sender typed it', () => {
    const titled = { note: 'Ship the lander', taskTitle: 'Ship the lander', sessionLabel: 'Draft' }
    expect(authoredHandoffNote(titled)).toBe('')
    expect(authoredHandoffNote({ ...titled, noteAuthored: true })).toBe('Ship the lander')
    expect(authoredHandoffNote({ ...titled, note: 'Check the pricing table' })).toBe(
      'Check the pricing table'
    )
    expect(authoredHandoffNote({ ...titled, note: 'Draft' })).toBe('')
  })

  it('finds the first thing a person asked', () => {
    const ask = message('user', 'Write ads')
    expect(firstPersonAsk([message('system', 'boot'), ask, message('user', 'more')])).toBe(ask)
    expect(firstPersonAsk([message('assistant', 'hi')])).toBeNull()
  })

  it('reads what the person typed, not the wrappers a CLI puts around it', () => {
    expect(
      personWords('<pasted_content id="85ce">\nWrite ads for OmniRogue\n</pasted_content>')
    ).toBe('Write ads for OmniRogue')
    expect(personWords('<system-reminder>\nhooks ran\n</system-reminder>\nFix the footer')).toBe(
      'Fix the footer'
    )
    const injected = message('user', '<system-reminder>session start</system-reminder>')
    const ask = message('user', 'Fix the footer')
    expect(firstPersonAsk([injected, ask])).toBe(ask)
  })
})

describe('what "work files" means when no stage produced a manifest', () => {
  const call = (name: string, input: unknown): NativeChatMessage => ({
    id: `${name}-${JSON.stringify(input).length}`,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name, input }],
    timestamp: null,
    source: 'transcript'
  })

  it('is the files the conversation itself wrote or edited, most recent last', () => {
    expect(
      conversationWrittenFiles([
        call('Write', { file_path: '/w/ads.md' }),
        call('Read', { file_path: '/w/secrets.env' }),
        call('Edit', { filePath: '/w/notes.md' }),
        call(
          'apply_patch',
          '*** Begin Patch\n*** Add File: docs/plan.md\n+x\n*** Update File: /w/ads.md\n'
        ),
        {
          id: 'result',
          role: 'tool',
          blocks: [
            { type: 'tool-result', output: 'ok', editPatch: { filePath: '/w/deck.md', hunks: [] } }
          ],
          timestamp: null,
          source: 'transcript'
        }
      ])
    ).toEqual(['/w/notes.md', 'docs/plan.md', '/w/ads.md', '/w/deck.md'])
    expect(conversationWrittenFiles([message('assistant', 'no tools')])).toEqual([])
  })

  it('names the summary for a person: the topic and when it was sent', () => {
    const at = new Date(2026, 8, 18, 13, 9, 24)
    expect(
      readablePackageFileName('Summary', '👥 Write five ad angles: for "OmniRogue"/DTC?', at)
    ).toBe('Summary - Write five ad angles for OmniRogue DTC - 2026-09-18 130924.md')
    expect(readablePackageFileName('Summary', '👤 ■', at)).toBe('Summary - 2026-09-18 130924.md')
    expect(readablePackageFileName('Conversation transcript', 'Write ads', at)).toBe(
      'Conversation transcript - Write ads - 2026-09-18 130924.md'
    )
  })
})
