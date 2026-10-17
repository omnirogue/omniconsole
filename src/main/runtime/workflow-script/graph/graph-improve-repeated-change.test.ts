import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import { graphUnchangedCallId } from './graph-improve-baseline'
import { IMPROVE_RULES } from './graph-improve-rules'
import type { GraphCall, GraphConfig } from './graph-plan'
import { drive, text } from './graph-test-harness'

const CODE: WorkflowCheck = { command: 'npm test', apply: 'patch' }
const RULES: Partial<GraphConfig> = {
  access: 'workspace-read',
  improveUnresolvedRounds: true,
  improveRules: IMPROVE_RULES
}
const UNCHANGED = `${graphUnchangedCallId('improve')}/check`

function improve(check: WorkflowCheck = CODE): WorkflowSpec {
  return {
    version: 1,
    title: 'Improve',
    template: 'improve',
    steps: [
      {
        id: 'improve',
        kind: 'do',
        title: 'Improve',
        instruction: '',
        agents: [{ route: 'claude' }, { route: 'claude' }],
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: [{ route: 'codex' }],
        inputs: ['improve'],
        jev: { method: 'auto', only: true }
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds: 3,
      patience: 2,
      explore: 'low',
      check
    }
  }
}

const diff = (body: string, hunk = '@@ -1 +1 @@') =>
  `\`\`\`diff\n--- a/x.ts\n+++ b/x.ts\n${hunk}\n${body}\n\`\`\``
const A = '-const x = 0\n+const x = 1'
const B = '-const x = 0\n+const x = 2'

/** Round.agent → what it writes: A twice in round 1 (one hunk header rewritten), then B. */
const WRITES: Record<string, string> = {
  '1.0': `First take.\n${diff(A)}`,
  '1.1': `Another take, the same change.\n${diff(A, '@@ -1,1 +1,1 @@ const x')}`,
  '2.0': `Back to the first idea.\n${diff(A)}`,
  '2.1': `Something new.\n${diff(B)}`,
  '3.0': `Again.\n${diff(B, '@@ -1,1 +1,1 @@')}`,
  '3.1': `Once more.\n${diff(B)}`
}

/** "No change" fails; change A passes with SCORE 1 and change B with SCORE 2. */
function answer(call: GraphCall): unknown {
  if (call.check) {
    if (call.check.unchanged) {
      return { markdown: 'check', passed: false, detail: 'fails' }
    }
    const score = call.check.candidate.includes('+const x = 2') ? 2 : 1
    return { markdown: 'check', passed: true, score, detail: 'ok' }
  }
  if (call.jev || call.stepId === 'judge') {
    return undefined
  }
  return text(WRITES[`${call.round}.${call.agentIndex}`] ?? '')
}

const checkIds = (plan: ReturnType<typeof drive>) =>
  plan.calls.filter((call) => call.check).map((call) => call.id)

describe('Improve rules 3: a change already checked is not tested or judged again', () => {
  it('reuses the first check of a change, in the same round or an earlier one', () => {
    const plan = drive(improve(), answer, RULES)
    const trail = plan.loop!.improve!
    expect(trail.rounds.map((round) => round.result)).toEqual(['new-best', 'new-best', 'kept'])
    // Six versions, two changes: only the first of each (and "No change") is tested.
    expect(checkIds(plan)).toEqual([UNCHANGED, 'improve/r1/a0/check', 'improve/r2/a1/check'])
    // The check decided every round; a repeat is never shown to a judge.
    expect(plan.calls.some((call) => call.jev || call.stepId === 'judge')).toBe(false)
    const first = trail.rounds[0]!
    const original = first.candidates.find((candidate) => candidate.accepted)!
    expect(first.candidates.find((candidate) => candidate.duplicateOf)).toMatchObject({
      check: { passed: true, score: 1 },
      duplicateOf: { round: 1, name: original.name }
    })
    const repeats = trail.rounds[2]!.candidates.filter((candidate) => candidate.duplicateOf)
    expect(repeats).toHaveLength(2)
    expect(plan.outcome?.final?.markdown).toMatch(/^Something new\./)
  })

  it('tells the next improvers which version repeated an earlier change', () => {
    const plan = drive(improve(), answer, RULES)
    const third = plan.calls.find((call) => call.id === 'improve/r3/a0')!.prompt
    expect(third).toMatch(
      /round 2: x\.ts: const x = 1 \(repeated the change .+ made in round 1\) \[failure: repeated_change; repeats: .+, round 1\]/
    )
  })

  it('tests every version under older rules, or when the command reads the version itself', () => {
    const older = drive(improve(), answer, { ...RULES, improveRules: 2 })
    expect(checkIds(older)).toContain('improve/r1/a1/check')
    const reads = drive(
      improve({ command: 'node grade.mjs {candidate}', apply: 'patch' }),
      answer,
      RULES
    )
    expect(checkIds(reads)).toContain('improve/r1/a1/check')
  })
})
