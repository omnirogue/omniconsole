import { describe, expect, it } from 'vitest'
import type { ArtifactReviewDecision } from './artifact-review'
import {
  artifactDecisionMessage,
  DECISION_EDITS_MAX_CHARS,
  formatDecisionEdits
} from './artifact-review-decision-message'

function decision(over: Partial<ArtifactReviewDecision> = {}): ArtifactReviewDecision {
  return {
    id: '7',
    revision: 2,
    decision: 'approved',
    comment: '',
    edits: null,
    by: { email: 'uma@example.edu', name: 'Uma Ozkan' },
    at: '2026-10-05T18:03:00Z',
    ...over
  }
}

const PAGE = {
  slug: 'abc',
  title: 'Build this session lifecycle?',
  shareUrl: 'https://console.example.com/a/abc'
}

describe('artifact decision message', () => {
  it('says to proceed on an approval, scoped to the revision', () => {
    const text = artifactDecisionMessage({ ...PAGE, decision: decision({ comment: 'go ahead' }) })
    expect(text.split('\n')).toEqual([
      '[OmniOS decision] Approved: revision 2 of "Build this session lifecycle?"',
      'By Uma Ozkan (uma@example.edu) at 2026-10-05 14:03 ET · https://console.example.com/a/abc',
      'Comment: "go ahead"',
      'Do now: carry out the plan exactly as approved in revision 2. This approval covers only what revision 2 says.',
      'Anything that moves money, reaches a customer, changes ad budgets or grants access still needs its own approval.',
      'Read the saved decision any time: omni artifacts status abc --json'
    ])
  })

  it('carries edits and asks for a new revision when they touch money or access', () => {
    const text = artifactDecisionMessage({
      ...PAGE,
      decision: decision({ edits: { budget: '$200/day', empty: '' } })
    })
    expect(text).toContain('Approved with edits: revision 2')
    expect(text).toContain('Edits:\nbudget: "$200/day"')
    expect(text).not.toContain('empty')
    expect(text).toContain('publish the edited version as revision 3 for approval')
  })

  it('delivers all eight native selections as structured JSON', () => {
    const picks = {
      selected: [1, 2, 3, 4, 5, 6, 7, 8],
      titles: Array.from({ length: 8 }, (_, i) => `Lane ${i + 1}`)
    }
    const text = artifactDecisionMessage({
      ...PAGE,
      decision: decision({ edits: { ...picks, pressed: true } })
    })
    expect(JSON.parse(text.split('Picks (JSON): ')[1].split('\n')[0])).toEqual(picks)
  })

  it('asks to revise and republish on a changes request, and says when the message woke it', () => {
    const text = artifactDecisionMessage({
      ...PAGE,
      woke: true,
      decision: decision({ decision: 'changes_requested', comment: 'cover Windows' })
    })
    expect(text).toContain('Changes requested on revision 2')
    expect(text).toContain(
      'Do not carry out the plan. This session sleeps again after you publish.'
    )
    expect(text).toContain('this message woke the same conversation')
  })

  it('tells a session to stop on a reject, naming a changed decision', () => {
    const text = artifactDecisionMessage({
      ...PAGE,
      rejectedWhileWorking: true,
      decision: decision({ decision: 'rejected' })
    })
    expect(text).toContain(
      'Uma Ozkan changed the decision to Reject. Stop and take no further action.'
    )
  })

  it('never words a decision it does not know as an approval', () => {
    const text = artifactDecisionMessage({
      ...PAGE,
      woke: true,
      decision: decision({ decision: 'needs_more_info' as never, comment: 'which market?' })
    })
    expect(text).toContain('[OmniOS decision] "needs_more_info" on revision 2')
    expect(text).toContain('this is not an approval, so do not carry out the plan')
    expect(text).toContain('Comment: "which market?"')
    expect(text).not.toContain('Approved')
    expect(text).not.toContain('carry out the plan exactly')
  })

  it('cuts long edits and points at the full saved decision', () => {
    const edits = formatDecisionEdits({ notes: 'x'.repeat(5_000) }, 'abc')!
    expect(edits.length).toBeLessThan(DECISION_EDITS_MAX_CHARS + 120)
    expect(edits).toContain('omni artifacts status abc --json')
    expect(formatDecisionEdits([], 'abc')).toBeNull()
    expect(formatDecisionEdits(['first', 'second'], 'abc')).toBe('["first","second"]')
  })

  it('says where a moved session now runs and whose accounts it uses', () => {
    const text = artifactDecisionMessage({
      slug: 'plan',
      title: 'Plan',
      shareUrl: 'https://omnios.example/a/plan',
      decision: decision(),
      woke: true,
      moved: {
        from: 'MacBook',
        to: 'Mac Studio',
        folder: '/Users/s/Work/Ops/X',
        account: 'studio@x.com'
      }
    })
    expect(text).toContain(
      'You were moved from MacBook to Mac Studio because MacBook was off. Your folder here is /Users/s/Work/Ops/X.'
    )
    expect(text).toContain("this computer's own accounts and logins (studio@x.com), not MacBook's")
  })
})
