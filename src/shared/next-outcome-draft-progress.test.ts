import { describe, expect, it } from 'vitest'
import { outcomeDraftProgress } from './next-outcome-draft-progress'
import { principalAttention } from './session-attention-drafts'
import { openHumanAttention } from './session-human-attention'
import { SESSION_RECOVERING_MAX_MS, type SessionOutcomeBlock } from './session-outcome-block'
import { blockRunOutcome, proveRun, runSet } from './session-run-lifecycle.test-fixture'

const NOW = 1_700_000_000_000
const STALL = "No activity was observed for 180s after this step's instruction was accepted."

function progressOf(block?: SessionOutcomeBlock, now = NOW) {
  const set = blockRunOutcome(runSet(), 'one', STALL, block)
  return outcomeDraftProgress(set.outcomes[0]!, set, 1, now)
}

/**
 * What a draft carries of the host's reading when it is hydrated. A draft can be shown without
 * its chain, so the stop's class has to travel with it: a stopped outcome used to hydrate as
 * `waiting`, and before that as "needs you" with the watchdog's sentence as its reason.
 */
describe('the host progress a draft carries', () => {
  it('carries failed for an exhausted or unclassified stop, and never a reason to show', () => {
    expect(progressOf({ class: 'failed', code: 'worker-stalled', since: NOW })).toEqual({
      status: 'failed',
      evidence: []
    })
    expect(progressOf()).toEqual({ status: 'failed', evidence: [] })
  })

  it('carries recovering while the host will act again, then failed once that went stale', () => {
    const block: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'worker-stalled',
      since: NOW,
      until: NOW + 15_000
    }
    expect(progressOf(block).status).toBe('recovering')
    expect(progressOf(block, NOW + 15_000 + SESSION_RECOVERING_MAX_MS).status).toBe('recovering')
    expect(progressOf(block, NOW + 15_001 + SESSION_RECOVERING_MAX_MS).status).toBe('failed')
  })

  it('keeps a registered wake as waiting', () => {
    expect(
      progressOf({ class: 'waiting', code: 'awaiting-evidence', since: NOW, wake: 'evidence' })
        .status
    ).toBe('waiting')
  })

  it('says needs-you only with an open request to the owner, whatever the block says', () => {
    const opened = openHumanAttention(
      runSet(),
      principalAttention({ outcomeId: 'one', outcomeRevision: 1 }),
      NOW
    )
    const set = blockRunOutcome(opened.set, 'one', STALL, {
      class: 'attention',
      code: 'principal',
      since: NOW,
      attentionIds: [opened.id]
    })
    expect(outcomeDraftProgress(set.outcomes[0]!, set, 1, NOW)).toEqual({
      status: 'needs-you',
      needsYouReason: 'Sign back in as the company and person this work was started under.',
      evidence: []
    })
  })

  it('reads a proven outcome as complete', () => {
    const set = proveRun(runSet(), 'one')
    expect(outcomeDraftProgress(set.outcomes[0]!, set, 1, NOW).status).toBe('complete')
  })
})
