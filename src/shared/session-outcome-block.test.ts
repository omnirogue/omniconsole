import { describe, expect, it } from 'vitest'
import {
  SESSION_RECOVERING_MAX_MS,
  UNCLASSIFIED_BLOCK_CODE,
  effectiveSessionOutcomeBlock,
  sessionOutcomeBlock,
  sessionOutcomeBlockSchema,
  type SessionOutcomeBlock
} from './session-outcome-block'

const NOW = 10_000_000

describe('the block a writer persists', () => {
  it('keeps when the block began across rewrites of the same class and code', () => {
    const first = sessionOutcomeBlock(
      { class: 'recovering', code: 'worker-stalled' },
      undefined,
      100
    )
    expect(first).toEqual({ class: 'recovering', code: 'worker-stalled', since: 100 })
    const again = sessionOutcomeBlock(
      { class: 'recovering', code: 'worker-stalled', until: 900 },
      first,
      500
    )
    // `since` stands so a stuck block can be seen to be stuck; the schedule follows the newest write.
    expect(again).toEqual({ class: 'recovering', code: 'worker-stalled', since: 100, until: 900 })
    expect(
      sessionOutcomeBlock({ class: 'recovering', code: 'worker-stalled' }, again, 700)
    ).toEqual({
      class: 'recovering',
      code: 'worker-stalled',
      since: 100
    })
  })

  it('starts a new age when the class or the code changes', () => {
    const previous: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'worker-stalled',
      since: 100
    }
    expect(
      sessionOutcomeBlock({ class: 'failed', code: 'worker-stalled' }, previous, 500).since
    ).toBe(500)
    expect(
      sessionOutcomeBlock({ class: 'recovering', code: 'worker-exited' }, previous, 500).since
    ).toBe(500)
  })

  it('carries the wake and the requests of the newest write', () => {
    expect(
      sessionOutcomeBlock(
        { class: 'waiting', code: 'evidence-poll', wake: '  pull request merge  ' },
        undefined,
        100
      )
    ).toEqual({ class: 'waiting', code: 'evidence-poll', since: 100, wake: 'pull request merge' })
    expect(
      sessionOutcomeBlock(
        { class: 'attention', code: 'agent-question', attentionIds: ['att_a', 'att_b'] },
        undefined,
        100
      )
    ).toEqual({
      class: 'attention',
      code: 'agent-question',
      since: 100,
      attentionIds: ['att_a', 'att_b']
    })
  })

  it('never produces a block the strict schema refuses', () => {
    const shaped = sessionOutcomeBlock(
      {
        class: 'failed',
        code: 'Review Round: HOLD!',
        wake: ' ',
        until: Number.NaN,
        attentionIds: Array.from({ length: 20 }, (_, index) => `att_${index}`)
      },
      undefined,
      100
    )
    expect(shaped.code).toBe('review-round-hold-')
    expect(shaped.wake).toBeUndefined()
    expect(shaped.until).toBeUndefined()
    expect(shaped.attentionIds).toHaveLength(16)
    expect(sessionOutcomeBlockSchema.safeParse(shaped).success).toBe(true)
    const unnamed = sessionOutcomeBlock({ class: 'failed', code: '!!!' }, undefined, 100)
    expect(unnamed.code).toBe(UNCLASSIFIED_BLOCK_CODE)
    expect(sessionOutcomeBlockSchema.safeParse(unnamed).success).toBe(true)
  })
})

describe('the block a reader sees', () => {
  const blocked = (block?: SessionOutcomeBlock) => ({
    status: 'blocked',
    ...(block ? { block } : {})
  })

  it('reads nothing for an outcome that is not blocked', () => {
    const block: SessionOutcomeBlock = { class: 'failed', code: 'worker-stalled', since: 1 }
    for (const status of ['pending', 'running', 'satisfied']) {
      expect(effectiveSessionOutcomeBlock({ status, block }, NOW)).toBeNull()
    }
  })

  it('reads a blocked outcome no writer classified as an honest, unclassified failure', () => {
    expect(effectiveSessionOutcomeBlock(blocked(), NOW)).toEqual({
      class: 'failed',
      code: UNCLASSIFIED_BLOCK_CODE,
      since: 0
    })
  })

  it('escalates a recovering block to failed only once nothing has acted for the maximum', () => {
    const fresh: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'worker-stalled',
      since: NOW - SESSION_RECOVERING_MAX_MS
    }
    expect(effectiveSessionOutcomeBlock(blocked(fresh), NOW)).toBe(fresh)
    expect(effectiveSessionOutcomeBlock(blocked(fresh), NOW + 1)).toEqual({
      ...fresh,
      class: 'failed'
    })
  })

  it('measures that from the scheduled action, so a backoff that just came due is not stale', () => {
    const scheduled: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'provider-usage-limit',
      since: NOW - 20 * 60_000,
      until: NOW + 60_000
    }
    expect(effectiveSessionOutcomeBlock(blocked(scheduled), NOW)).toBe(scheduled)
    expect(effectiveSessionOutcomeBlock(blocked(scheduled), NOW + 60_001)).toBe(scheduled)
    expect(
      effectiveSessionOutcomeBlock(blocked(scheduled), NOW + 60_000 + SESSION_RECOVERING_MAX_MS)
    ).toBe(scheduled)
    expect(
      effectiveSessionOutcomeBlock(blocked(scheduled), NOW + 60_001 + SESSION_RECOVERING_MAX_MS)
        ?.class
    ).toBe('failed')
  })

  it('never escalates a waiting, attention or failed block by age', () => {
    for (const kind of ['waiting', 'attention', 'failed'] as const) {
      const old: SessionOutcomeBlock = { class: kind, code: 'held', since: 0 }
      expect(effectiveSessionOutcomeBlock(blocked(old), NOW * 1_000)).toBe(old)
    }
  })
})
