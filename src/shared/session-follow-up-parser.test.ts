import { describe, expect, it } from 'vitest'
import { parseDuePhrase, parseFollowUpRequest } from './session-follow-up-parser'

// Wednesday 9 September 2026, 10:00 local time.
const now = new Date(2026, 8, 9, 10, 0)

function local(date: Date | string | null): [number, number, number, number, number] | null {
  if (!date) {
    return null
  }
  const value = new Date(date)
  return [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes()
  ]
}

describe('follow-up request parser', () => {
  it('reads the canonical sentence', () => {
    expect(
      parseFollowUpRequest('Once done, send the final deliverables to Iris for review', now)
    ).toEqual({
      whenFinished: true,
      action: 'review',
      recipientNames: ['Iris'],
      deliverables: { kind: 'final' },
      includeSummary: false,
      due: null
    })
  })

  it('reads several people, named files, an action and a due phrase', () => {
    const intent = parseFollowUpRequest(
      'when finished send report.md and deck.pptx to Iriis and Gamma to approve by Friday 5pm',
      now
    )
    expect(intent.action).toBe('approve')
    expect(intent.recipientNames).toEqual(['Iriis', 'Gamma'])
    expect(intent.deliverables).toEqual({ kind: 'files', names: ['report.md', 'deck.pptx'] })
    expect(intent.due?.phrase).toBe('Friday 5pm')
    expect(local(intent.due?.at ?? null)).toEqual([2026, 9, 11, 17, 0])
  })

  it('reads dative, ask and fyi phrasings and a requested summary', () => {
    expect(
      parseFollowUpRequest("When it's done send Iris the final deliverables for review", now)
        .recipientNames
    ).toEqual(['Iris'])
    const ask = parseFollowUpRequest('ask Iris to review the deck with a summary', now)
    expect(ask.recipientNames).toEqual(['Iris'])
    expect(ask.action).toBe('review')
    expect(ask.includeSummary).toBe(true)
    const fyi = parseFollowUpRequest('once done send notes.md to Eve fyi', now)
    expect(fyi).toMatchObject({ action: 'fyi', recipientNames: ['Eve'] })
    expect(fyi.deliverables).toEqual({ kind: 'files', names: ['notes.md'] })
  })

  it('reports only what the text says', () => {
    const plain = parseFollowUpRequest('Send the deck to Gamma by tomorrow', now)
    expect(plain).toMatchObject({
      whenFinished: false,
      action: null,
      recipientNames: ['Gamma'],
      deliverables: null
    })
    expect(local(plain.due?.at ?? null)).toEqual([2026, 9, 10, 17, 0])
    expect(
      parseFollowUpRequest('once done send the final deliverables', now).recipientNames
    ).toEqual([])
    expect(
      parseFollowUpRequest('see console.example.com, e.g. the docs', now).deliverables
    ).toBeNull()
  })

  it('parses due phrases in local time and rolls a passed weekday or time forward', () => {
    expect(local(parseDuePhrase('tomorrow noon', now))).toEqual([2026, 9, 10, 12, 0])
    expect(local(parseDuePhrase('2026-09-15 14:00', now))).toEqual([2026, 9, 15, 14, 0])
    expect(local(parseDuePhrase('Sep 20', now))).toEqual([2026, 9, 20, 17, 0])
    expect(local(parseDuePhrase('15th Oct', now))).toEqual([2026, 10, 15, 17, 0])
    expect(local(parseDuePhrase('9am', now))).toEqual([2026, 9, 10, 9, 0])
    expect(local(parseDuePhrase('Wednesday 9am', now))).toEqual([2026, 9, 16, 9, 0])
    expect(local(parseDuePhrase('eod', now))).toEqual([2026, 9, 9, 17, 0])
    expect(parseDuePhrase('banana', now)).toBeNull()
    expect(parseDuePhrase('13pm', now)).toBeNull()
  })
})
