import type { WorkPlan } from '../../work-plan-types'
import { WORK_PLAN_FIXTURE_ACTORS } from './work-plan-context'

const { claude, codex, grok } = WORK_PLAN_FIXTURE_ACTORS

/**
 * The shortest complete loop: build → check the result against what done means → repair what
 * failed. The gate ranges over done-when entries, not over another step, and names where a
 * failure goes; without that name a failure blocks the outcome instead.
 */
export function outcomeGateWorkPlan(): WorkPlan {
  return {
    outcome: {
      title: 'Billing export ships',
      outputKind: 'work',
      doneWhen: [
        { id: 'dw-check', text: 'the export check reports PASS', evidence: 'report' },
        { id: 'dw-file', text: 'the export file exists', evidence: 'file', path: 'out/export.csv' }
      ]
    },
    nodes: [
      {
        kind: 'worker',
        id: 'build',
        role: 'implement',
        instruction: '',
        actor: claude,
        writes: 'workspace'
      },
      {
        kind: 'worker',
        id: 'gate',
        role: 'verify',
        instruction: '',
        actor: codex,
        readsFrom: ['build'],
        verdict: { kind: 'verify', over: ['dw-check', 'dw-file'], consumed: 'gate' },
        onFail: 'fix'
      },
      {
        kind: 'worker',
        id: 'fix',
        role: 'repair',
        instruction: '',
        actor: grok,
        readsFrom: ['gate'],
        writes: 'workspace'
      },
      { kind: 'finish', id: 'done', how: 'complete' }
    ]
  }
}
