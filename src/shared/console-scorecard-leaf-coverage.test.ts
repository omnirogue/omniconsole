import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countMap, coercedText, countOrZero, looseLabel } from './console-scorecard-leaves'
import { scorecardDocument } from './console-scorecard-contract'

/**
 * The rule this file enforces, because it has now been missed three times.
 *
 * Every numeric field in the scorecard contracts must come from a leaf that COERCES a
 * numeric string. The collector emits money as text — the console's own decoder coerces it
 * and says so in a comment ("Meta reports spend as text") — and nothing in this document
 * carries a per-row `.catch()`, so one bare `z.number()` on one field fails the whole parse
 * and blanks every stat on the Work home.
 *
 * It was fixed once on the money leaves, then found again on five count leaves, then again
 * on an id and four labels. A rule missed three times is not a thing to remember; it is a
 * thing to assert. So this test reads the source and fails on a bare leaf, rather than
 * trusting the next person to recall it.
 */

const CONTRACTS = [
  'console-scorecard-contract.ts',
  'console-scorecard-finance.ts',
  'console-scorecard-service.ts',
  'console-scorecard-operations.ts',
  'console-scorecard-provider-bills.ts'
] as const

function source(name: string): string {
  return readFileSync(join(__dirname, name), 'utf8')
}

describe('every scorecard leaf tolerates what the collector actually sends', () => {
  it('declares no bare numeric leaf in any scorecard contract', () => {
    const offenders: string[] = []
    for (const name of CONTRACTS) {
      source(name)
        .split('\n')
        .forEach((line, index) => {
          // `z.number()` is legitimate only inside the leaves file, which this list excludes.
          if (line.includes('z.number()')) {
            offenders.push(`${name}:${index + 1} ${line.trim()}`)
          }
        })
    }
    expect(
      offenders,
      'Use countOrZero / looseNumber / looseCount from console-scorecard-leaves instead: a bare z.number() rejects the numeric string the collector sends and fails the whole document.'
    ).toEqual([])
  })

  it('tolerates a wrong type on exactly the fields the original coerces', () => {
    // A source scan over-fires here: the original REQUIRES some strings (a task id, a
    // domain name, a repository) and coerces others. So this asserts the behaviour of the
    // ones it coerces, field by field, rather than matching a shape.
    const document = scorecardDocument.parse({
      generated_at: '2026-09-12T16:00:00Z',
      today: '2026-09-12',
      companies: [],
      customer_service: {
        omnirogue: {
          slug: 'omnirogue',
          recent_tickets: [{ id: 7, subject: 99, status: 404 }]
        }
      },
      operations: {
        omnirogue: {
          slug: 'omnirogue',
          tasks: { blocked_reasons: [{ reason: 12, n: 1 }] },
          waiting_on_human: [{ id: 't1', title: 42 }]
        }
      }
    })
    const ticket = document.customer_service?.omnirogue.recent_tickets[0]
    expect(ticket?.id).toBe('7')
    // The original names each absence rather than leaving it blank.
    expect(ticket?.subject).toBe('(no subject)')
    expect(ticket?.status).toBe('unknown')
    expect(document.operations?.omnirogue.tasks?.blocked_reasons[0].reason).toBe('unstated')
    expect(document.operations?.omnirogue.waiting_on_human?.[0].title).toBe('')
  })

  it('still requires the strings the original requires', () => {
    // A task with no id, or a division row with no name, is a malformed row in both.
    const base = {
      generated_at: '2026-09-12T16:00:00Z',
      today: '2026-09-12',
      companies: []
    }
    expect(
      scorecardDocument.safeParse({
        ...base,
        operations: { omnirogue: { slug: 'omnirogue', waiting_on_human: [{ title: 'no id' }] } }
      }).success
    ).toBe(false)
    expect(
      scorecardDocument.safeParse({
        ...base,
        operations: {
          omnirogue: { slug: 'omnirogue', tasks: { by_domain: [{ live: 1 }] } }
        }
      }).success
    ).toBe(false)
  })
})

describe('the tolerant leaves behave as the original does', () => {
  it('folds an unreadable count to zero, as optNum(x) ?? 0 does', () => {
    expect(countOrZero.parse('3')).toBe(3)
    expect(countOrZero.parse(3)).toBe(3)
    expect(countOrZero.parse(undefined)).toBe(0)
    expect(countOrZero.parse(null)).toBe(0)
    expect(countOrZero.parse('nonsense')).toBe(0)
  })

  it('coerces any id to a readable string, as String(x ?? "") does', () => {
    expect(coercedText.parse(4821)).toBe('4821')
    expect(coercedText.parse('t-1')).toBe('t-1')
    expect(coercedText.parse(null)).toBe('')
    expect(coercedText.parse(undefined)).toBe('')
  })

  it('treats a wrong-typed label as absent, substituting the named fallback', () => {
    expect(looseLabel().parse('Refund')).toBe('Refund')
    expect(looseLabel().parse(42)).toBe('')
    expect(looseLabel('unstated').parse(42)).toBe('unstated')
    expect(looseLabel('unstated').parse(undefined)).toBe('unstated')
    expect(looseLabel('unstated').parse('')).toBe('unstated')
  })

  it('drops an unreadable entry from a count map and keeps the rest', () => {
    // Failing the map would lose every readable count with the one bad entry.
    expect(countMap.parse({ live: '3', blocked: 2, broken: 'nonsense', nested: {} })).toEqual({
      live: 3,
      blocked: 2
    })
    expect(countMap.parse(undefined)).toEqual({})
  })
})

describe('a whole document the collector could really send', () => {
  it('reads counts, ids and labels that arrive in the wrong shape', () => {
    // Every field here is one a bare leaf rejected, failing the entire document.
    const document = scorecardDocument.parse({
      generated_at: '2026-09-12T16:00:00Z',
      today: '2026-09-12',
      companies: [],
      ads_accounts: [
        { company: 'omnirogue', account_id: 'act_1', hourly: [{ hour: '14', spend: '12.50' }] }
      ],
      customer_service: {
        omnirogue: {
          slug: 'omnirogue',
          recent_tickets: [{ id: 4821, subject: 99, status: 'open' }],
          sentiment: { method: 'scan', categories: [{ name: 'refund', n: '7' }] }
        }
      },
      operations: {
        omnirogue: {
          slug: 'omnirogue',
          tasks: {
            by_status: { live: '3', broken: 'nonsense' },
            by_domain: [{ name: 'Sales', live: '3', blocked: 0, in_progress: 0 }],
            blocked_reasons: [{ reason: 'stuck', n: '2' }]
          },
          waiting_on_human: [{ id: 't1', title: 42 }]
        }
      }
    })
    expect(document.ads_accounts[0].hourly[0].hour).toBe(14)
    expect(document.customer_service?.omnirogue.recent_tickets[0].id).toBe('4821')
    expect(document.customer_service?.omnirogue.sentiment?.categories[0].n).toBe(7)
    expect(document.operations?.omnirogue.tasks?.by_status).toEqual({ live: 3 })
    expect(document.operations?.omnirogue.tasks?.by_domain[0].live).toBe(3)
    expect(document.operations?.omnirogue.tasks?.blocked_reasons[0].n).toBe(2)
    // A wrong-typed title reads as absent; the row survives and keeps its id.
    expect(document.operations?.omnirogue.waiting_on_human?.[0].title).toBe('')
    expect(document.operations?.omnirogue.waiting_on_human?.[0].id).toBe('t1')
  })
})
