import { describe, expect, it } from 'vitest'
import {
  summarizeAnswerDeliveryPilot,
  type AnswerDeliveryPilotRecord
} from './answer-delivery-pilot-report'

const base = Date.parse('2026-10-17T20:00:00Z')
const at = (offsetMs: number) => new Date(base + offsetMs).toISOString()

function line(id: string, outcome: AnswerDeliveryPilotRecord['outcome'], extra = {}): string {
  return JSON.stringify({
    key: `review:p:${id}`,
    id,
    conversation: 'claude:conv-1',
    path: null,
    claimedAt: at(0),
    injectedAt: null,
    confirmedAt: null,
    fallbackAt: null,
    ackAt: null,
    attempts: 0,
    outcome,
    ...extra
  })
}

describe('summarizeAnswerDeliveryPilot', () => {
  it('keeps the latest line per delivery and reports paths, latency, fallback rate and open items', () => {
    const text = [
      line('a', 'open'),
      line('a', 'confirmed', { path: 'hook_stop', confirmedAt: at(40_000), attempts: 1 }),
      line('b', 'open'),
      line('b', 'confirmed', { path: 'hook_post_tool', confirmedAt: at(400_000), attempts: 2 }),
      line('c', 'open'),
      line('c', 'typed_fallback', { path: 'typed_fallback', fallbackAt: at(300_000), attempts: 0 }),
      line('d', 'open'),
      line('old', 'confirmed', { claimedAt: at(-3 * 86_400_000), path: 'hook_prompt' }),
      'not json',
      ''
    ].join('\n')
    const report = summarizeAnswerDeliveryPilot(text, base - 86_400_000)
    expect(report).toMatchObject({
      deliveries: 4,
      byPath: { hook_stop: 1, hook_post_tool: 1, typed_fallback: 1 },
      outcomes: { open: 1, confirmed: 2, typed_fallback: 1, withdrawn: 0 },
      latencyMs: { p50: 40_000, p95: 400_000, samples: 2 },
      fallbackRate: 1 / 3,
      confirmedWithin5mRate: 1 / 3,
      medianAttempts: 1,
      open: 1,
      invalidLines: 1
    })
  })

  it('reports nothing measured for an empty file', () => {
    expect(summarizeAnswerDeliveryPilot('', 0)).toMatchObject({
      deliveries: 0,
      latencyMs: { p50: null, p95: null, samples: 0 },
      fallbackRate: null,
      medianAttempts: null
    })
  })

  it('counts a re-claim of the same answer as a separate delivery', () => {
    const text = [
      line('a', 'confirmed', { confirmedAt: at(10_000), attempts: 1 }),
      line('a', 'open', { claimedAt: at(20_000) })
    ].join('\n')
    expect(summarizeAnswerDeliveryPilot(text, base)).toMatchObject({
      deliveries: 2,
      outcomes: { confirmed: 1, open: 1 },
      latencyMs: { samples: 1, p50: 10_000 },
      open: 1
    })
  })

  it('includes the exact since boundary and excludes earlier claims', () => {
    const text = [line('old', 'open', { claimedAt: at(-1) }), line('current', 'open')].join('\n')
    expect(summarizeAnswerDeliveryPilot(text, base).deliveries).toBe(1)
  })

  it('keeps withdrawn deliveries out of fallback and confirmation rates', () => {
    const text = [
      line('a', 'withdrawn', { attempts: 2, path: 'hook_stop' }),
      line('b', 'open', { attempts: 99, path: 'hook_stop' })
    ].join('\n')
    expect(summarizeAnswerDeliveryPilot(text, base)).toMatchObject({
      deliveries: 2,
      byPath: { hook_stop: 1 },
      fallbackRate: null,
      confirmedWithin5mRate: null,
      medianAttempts: 2
    })
  })

  it('counts confirmation at exactly five minutes as within the target', () => {
    const text = [
      line('a', 'confirmed', { confirmedAt: at(300_000), attempts: 1 }),
      line('b', 'confirmed', { confirmedAt: at(300_001), attempts: 2 })
    ].join('\n')
    expect(summarizeAnswerDeliveryPilot(text, base)).toMatchObject({
      confirmedWithin5mRate: 0.5,
      latencyMs: { p50: 300_000, p95: 300_001, samples: 2 },
      medianAttempts: 1
    })
  })

  it('skips invalid confirmation timestamps without fabricating latency', () => {
    const text = line('a', 'confirmed', { confirmedAt: 'invalid', attempts: 1 })
    expect(summarizeAnswerDeliveryPilot(text, base)).toMatchObject({
      deliveries: 1,
      latencyMs: { p50: null, p95: null, samples: 0 },
      confirmedWithin5mRate: 0
    })
  })

  it('counts malformed JSON and invalid record shapes while ignoring blank lines', () => {
    const text = ['{', 'null', '[]', '{}', '  ', line('a', 'open')].join('\n')
    expect(summarizeAnswerDeliveryPilot(text, base)).toMatchObject({
      deliveries: 1,
      invalidLines: 4,
      open: 1
    })
  })

  it('ignores a record whose claim time cannot be parsed', () => {
    const text = line('a', 'open', { claimedAt: 'not-a-date' })
    expect(summarizeAnswerDeliveryPilot(text, base)).toMatchObject({
      deliveries: 0,
      open: 0,
      invalidLines: 0
    })
  })
})
