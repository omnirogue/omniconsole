import { describe, expect, it } from 'vitest'
import type { SessionOutcomeBlock } from '../../shared/session-outcome-block'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  keepSessionOutcomeBlockSince,
  keepStepRunnerHolds,
  rememberSessionOutcomeBlocks
} from './session-outcome-block-since'

const BEGAN = 1_000
const NOW = 61_000

function outcome(
  id: string,
  status: SessionOutcome['status'],
  block?: SessionOutcomeBlock
): SessionOutcome {
  return {
    id,
    title: id,
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: 'file', kind: 'file', target: `/workspace/${id}.txt` }],
    actions: [],
    revision: 1,
    status,
    evidence: [],
    ...(block ? { blockedReason: `${block.code} (diagnostic)`, block } : {})
  }
}

function setOf(...outcomes: SessionOutcome[]): SessionOutcomeSet {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: 1,
    removals: [],
    attempts: [],
    completedSteps: [],
    continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    outcomes
  }
}

const deliverables = (since: number): SessionOutcomeBlock => ({
  class: 'waiting',
  code: 'handoff-deliverables',
  wake: 'deliverables',
  since
})

describe('the start of a block this pass cleared and wrote back', () => {
  it('is the start it had when the pass began', () => {
    const began = rememberSessionOutcomeBlocks(
      setOf(outcome('handoff', 'blocked', deliverables(BEGAN)))
    )
    const rewritten = keepSessionOutcomeBlockSince(
      setOf(outcome('handoff', 'blocked', deliverables(NOW))),
      began
    )
    expect(rewritten.outcomes[0]!.block).toEqual(deliverables(BEGAN))
  })

  it('restarts for a block of another class or code, and never outlives a cleared one', () => {
    const began = rememberSessionOutcomeBlocks(
      setOf(outcome('handoff', 'blocked', deliverables(BEGAN)), outcome('other', 'pending'))
    )
    const next = setOf(
      outcome('handoff', 'blocked', { class: 'failed', code: 'handoff-delivery', since: NOW }),
      outcome('other', 'blocked', deliverables(NOW))
    )
    // Nothing to carry: the same set back, so a save that compares finds nothing changed.
    expect(keepSessionOutcomeBlockSince(next, began)).toBe(next)
    const cleared = setOf(outcome('handoff', 'pending'))
    expect(keepSessionOutcomeBlockSince(cleared, began)).toBe(cleared)
  })
})

describe('a hold the step runner wrote, and the recompute after it', () => {
  const beforeRun = setOf(outcome('handoff', 'pending'), outcome('gate', 'pending'))

  it('stands when that recompute could not re-derive it', () => {
    const ran = setOf(outcome('handoff', 'blocked', deliverables(NOW)), outcome('gate', 'pending'))
    const recomputed = setOf(outcome('handoff', 'pending'), outcome('gate', 'running'))
    const kept = keepStepRunnerHolds(recomputed, ran, beforeRun)
    expect(kept.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'handoff-deliverables (diagnostic)',
      block: deliverables(NOW)
    })
    expect(kept.outcomes[1]).toBe(recomputed.outcomes[1])
  })

  it('gives way to what the recompute decided itself', () => {
    const ran = setOf(outcome('handoff', 'blocked', deliverables(NOW)), outcome('gate', 'pending'))
    const settled = setOf(outcome('handoff', 'satisfied'), outcome('gate', 'pending'))
    expect(keepStepRunnerHolds(settled, ran, beforeRun)).toBe(settled)
    const reheld = setOf(
      outcome('handoff', 'blocked', { class: 'recovering', code: 'worker-exited', since: NOW }),
      outcome('gate', 'pending')
    )
    expect(keepStepRunnerHolds(reheld, ran, beforeRun)).toBe(reheld)
  })

  it('never puts back a hold that asked a person, or one that was there before the run', () => {
    const asked = setOf(
      outcome('handoff', 'pending'),
      outcome('gate', 'blocked', {
        class: 'attention',
        code: 'verification-gate',
        since: NOW,
        attentionIds: ['att_verification_gate']
      })
    )
    const recomputed = setOf(outcome('handoff', 'pending'), outcome('gate', 'pending'))
    expect(keepStepRunnerHolds(recomputed, asked, beforeRun)).toBe(recomputed)
    const earlier = setOf(
      outcome('handoff', 'blocked', deliverables(BEGAN)),
      outcome('gate', 'pending')
    )
    expect(keepStepRunnerHolds(recomputed, earlier, earlier)).toBe(recomputed)
  })
})
