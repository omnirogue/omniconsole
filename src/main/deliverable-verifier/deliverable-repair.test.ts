import { describe, expect, it } from 'vitest'
import type { DeliverableCheck } from '../../shared/deliverable-verification-types'
import {
  DELIVERABLE_REPAIR_PROMPT_MAX,
  decideDeliverableRepair,
  deliverableRepairPrompt,
  parseDeliverableRepairMarker,
  type DeliverableRepairFacts
} from './deliverable-repair'

const missing = (target: string, extra: Partial<DeliverableCheck> = {}): DeliverableCheck => ({
  target,
  kind: 'file',
  source: 'request',
  claim: 'named',
  verdict: 'missing',
  detail: 'no file on this computer',
  ...extra
})

const facts = (extra: Partial<DeliverableRepairFacts> = {}): DeliverableRepairFacts => ({
  mode: 'on',
  maxRepairs: 2,
  overall: 'incomplete',
  checks: [missing('a.md')],
  repairsSent: 0,
  conversationRepairsInWindow: 0,
  missingBeforeRepair: null,
  replyAsksPerson: false,
  agentWaiting: false,
  pendingQuestion: false,
  keepGoing: false,
  queuedEntry: false,
  ...extra
})

describe('decideDeliverableRepair', () => {
  it('repairs in on mode and only watches in shadow', () => {
    expect(decideDeliverableRepair(facts()).action).toBe('repair-sent')
    expect(decideDeliverableRepair(facts({ mode: 'shadow' })).action).toBe('would-repair')
  })

  it('does nothing when complete or only unverifiable', () => {
    expect(decideDeliverableRepair(facts({ overall: 'complete', checks: [] })).action).toBe('none')
    expect(
      decideDeliverableRepair(
        facts({ overall: 'unverifiable', checks: [missing('a.md', { verdict: 'unverifiable' })] })
      ).action
    ).toBe('none')
  })

  it('stops on no progress and when the budget is spent', () => {
    expect(decideDeliverableRepair(facts({ missingBeforeRepair: ['a.md'] })).action).toBe(
      'stopped:no-progress'
    )
    // b.md was fixed: progress, even though a.md is still missing.
    expect(decideDeliverableRepair(facts({ missingBeforeRepair: ['a.md', 'b.md'] })).action).toBe(
      'repair-sent'
    )
    expect(decideDeliverableRepair(facts({ repairsSent: 2 })).action).toBe('exhausted')
    // One fixed, one new missing: progress, so the second attempt is allowed.
    expect(
      decideDeliverableRepair(facts({ repairsSent: 1, missingBeforeRepair: ['b.md'] })).action
    ).toBe('repair-sent')
  })

  it('skips with the first blocker named', () => {
    const cases: [Partial<DeliverableRepairFacts>, string][] = [
      [{ replyAsksPerson: true }, 'skipped:asks-person'],
      [{ agentWaiting: true }, 'skipped:agent-waiting'],
      [{ pendingQuestion: true }, 'skipped:pending-question'],
      [{ keepGoing: true }, 'skipped:keep-going'],
      [{ queuedEntry: true }, 'skipped:queued-message']
    ]
    for (const [extra, action] of cases) {
      expect(decideDeliverableRepair(facts(extra)).action).toBe(action)
      expect(decideDeliverableRepair(facts({ ...extra, mode: 'shadow' })).action).toBe(action)
    }
  })
})

describe('deliverableRepairPrompt', () => {
  it('names each item, its reason and the marker', () => {
    const text = deliverableRepairPrompt({
      attempt: 1,
      max: 2,
      token: '7f3a9c01',
      missing: [
        missing('/plans/Spec.md'),
        missing('docs/plan.md', {
          source: 'claim',
          claim: 'created',
          detail: 'the file is empty (0 bytes)'
        })
      ],
      checkedAt: new Date(2026, 9, 17, 14, 2).getTime()
    })
    expect(text).toContain('[from Deliverable check 1/2 · dv-7f3a9c01] Before this is finished')
    expect(text).toContain(
      '1. /plans/Spec.md (you were asked to write it there) — no file on this computer, checked 14:02.'
    )
    expect(text).toContain(
      '2. docs/plan.md (your reply says it was created) — the file is empty (0 bytes), checked 14:02.'
    )
    expect(text).toContain('Do not take any irreversible or outward-facing step')
    expect(parseDeliverableRepairMarker(text)).toEqual({ attempt: 1, max: 2, token: '7f3a9c01' })
  })

  it('stays within 2,000 characters however many items', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      missing(`docs/${'x'.repeat(80)}-${index}.md`)
    )
    const text = deliverableRepairPrompt({
      attempt: 2,
      max: 2,
      token: 'abcd1234',
      missing: many,
      checkedAt: 0
    })
    expect(text.length).toBeLessThanOrEqual(DELIVERABLE_REPAIR_PROMPT_MAX)
    expect(text).toMatch(/…and \d+ more\./)
    expect(text).toContain('Then list each deliverable with its path or link.')
  })

  it('reads no marker from an ordinary prompt', () => {
    expect(parseDeliverableRepairMarker('Please write a.md')).toBeNull()
    expect(parseDeliverableRepairMarker(undefined)).toBeNull()
  })

  it('stops at the hourly cap for the conversation, whatever the request', () => {
    expect(decideDeliverableRepair(facts({ conversationRepairsInWindow: 3 })).action).toBe(
      'skipped:hourly-cap'
    )
    expect(decideDeliverableRepair(facts({ conversationRepairsInWindow: 2 })).action).toBe(
      'repair-sent'
    )
  })
})
