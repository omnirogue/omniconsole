import type { WorkPlan } from '../../work-plan-types'
import { WORK_PLAN_FIXTURE_ACTORS } from './work-plan-context'

const { claude, codex, grok, kimi } = WORK_PLAN_FIXTURE_ACTORS

/**
 * Sal's worked example: ⑂3 Research → ◇ Synthesize → ⑂3 Plan → ⚖ Judge → ✨ Improve → ✓ Verify → 👤 Me.
 * Six stages (the cap) and sixteen compiled seats; the judge is the one family none of the
 * planners belong to, and Improve runs on whatever the judge picked.
 */
export function samWorkPlan(): WorkPlan {
  return {
    outcome: {
      title: 'Ship the launch page',
      outputKind: 'work',
      doneWhen: [
        { id: 'dw-copy', text: 'the page states the offer and the price', evidence: 'report' },
        {
          id: 'dw-page',
          text: 'the page file is in the workspace',
          evidence: 'file',
          path: 'index.html'
        },
        { id: 'dw-review', text: 'three reviewers found nothing blocking', evidence: 'verdict' }
      ]
    },
    nodes: [
      {
        kind: 'worker',
        id: 'research',
        role: 'research',
        instruction: '',
        count: 3,
        actor: claude,
        seats: [claude, codex, grok]
      },
      {
        kind: 'worker',
        id: 'synthesis',
        role: 'synthesize',
        instruction: '',
        actor: claude,
        readsFrom: ['research']
      },
      {
        kind: 'worker',
        id: 'plan',
        role: 'plan',
        instruction: '',
        count: 3,
        actor: claude,
        seats: [claude, codex, grok],
        readsFrom: ['synthesis']
      },
      {
        kind: 'worker',
        id: 'plan-judge',
        role: 'judge',
        instruction: '',
        actor: kimi,
        readsFrom: ['plan'],
        verdict: { kind: 'judge', over: ['plan'], consumed: 'select-winner' }
      },
      {
        kind: 'worker',
        id: 'improve',
        role: 'improve',
        instruction: '',
        actor: claude,
        readsFrom: ['plan-judge'],
        readsWinnerOf: 'plan-judge',
        writes: 'workspace'
      },
      {
        kind: 'review',
        id: 'verify',
        actor: codex,
        seats: [codex, grok, kimi],
        readsFrom: ['improve'],
        loop: 'review',
        maxRounds: 2,
        stop: 'zero_blockers',
        verdict: { kind: 'verify', over: ['improve'], consumed: 'gate' }
      },
      { kind: 'finish', id: 'me', how: 'my-review', route: 'human' }
    ]
  }
}
