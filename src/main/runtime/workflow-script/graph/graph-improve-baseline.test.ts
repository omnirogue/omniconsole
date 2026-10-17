import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { graphUnchangedCallId } from './graph-improve-baseline'
import {
  assertImproveReplaySupported,
  graphImproveChangesCode,
  IMPROVE_RULES
} from './graph-improve-rules'
import {
  planWorkflowGraph,
  type GraphCall,
  type GraphConfig,
  type GraphOutcome
} from './graph-plan'
import { configFor, drive, task, text } from './graph-test-harness'

const CODE: WorkflowCheck = {
  command: 'npm test',
  apply: 'patch',
  prepare: 'npm ci',
  protect: ['tests/**']
}

function improve(check: WorkflowCheck = CODE, agents = 2): WorkflowSpec {
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
        agents: Array.from({ length: agents }, () => ({ route: 'claude' as const })),
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
      maxRounds: 4,
      patience: 1,
      explore: 'low',
      check
    }
  }
}

const RULES_2: Partial<GraphConfig> = {
  access: 'workspace-read',
  improveUnresolvedRounds: true,
  improveRules: IMPROVE_RULES
}
const UNCHANGED_CHECK = `${graphUnchangedCallId('improve')}/check`

/** Each version's check: "No change" by `unchanged`, a change by the PASS/FAIL it carries. */
function answer(unchanged: boolean) {
  return (call: GraphCall): unknown => {
    if (call.check) {
      const passed = call.check.unchanged ? unchanged : /PASS/.test(call.check.candidate)
      return { markdown: 'check', passed, detail: passed ? 'ok' : 'value is 1' }
    }
    if (call.jev || call.stepId === 'judge') {
      return undefined
    }
    return text(`Round ${call.round} change ${call.agentIndex}: FAIL\n\`\`\`diff\n-a\n+b\n\`\`\``)
  }
}

describe('Improve with changes to the code: "No change" holds the lead first', () => {
  it("checks the code as it is before any improver starts, with the person's settings", () => {
    const config = { ...configFor(improve()), ...RULES_2 }
    const plan = planWorkflowGraph(config, task, new Map())
    expect(plan.ready.map((call) => call.id)).toEqual([UNCHANGED_CHECK])
    expect(plan.ready[0]!.check).toMatchObject({
      command: 'npm test',
      apply: 'patch',
      prepare: 'npm ci',
      protect: ['tests/**'],
      unchanged: true,
      scoreLastLine: true
    })
    expect(plan.loop).toMatchObject({ round: 1, status: 'running' })
  })

  it("tells round one's improvers how to write a diff, and what the code as it is does", () => {
    const config = { ...configFor(improve()), ...RULES_2 }
    const outcomes = new Map<string, GraphOutcome>([
      [UNCHANGED_CHECK, { value: { passed: false, detail: 'value is 1' } }]
    ])
    const plan = planWorkflowGraph(config, task, outcomes)
    expect(plan.ready.map((call) => call.id)).toEqual(['improve/r1/a0', 'improve/r1/a1'])
    const prompt = plan.ready[0]!.prompt
    expect(prompt).toContain('Produce a complete solution to the task below')
    expect(prompt).toContain(
      'one unified diff (the format `git diff` prints) in a single ```diff block'
    )
    expect(prompt).toContain('Never change these files (a diff that touches one fails): tests/**')
    expect(prompt).toContain("in a private copy of the code with the version's diff applied")
    expect(prompt).toContain('The code as it is now, with no change, FAILS it')
    expect(prompt).not.toContain('The best version so far')
  })

  it('leaves the code unchanged when no change beats it, and never asks a judge', () => {
    const plan = drive(improve(), answer(true), RULES_2)
    const trail = plan.loop!.improve!
    expect(trail.rounds[0]).toMatchObject({ round: 1, mode: 'first', result: 'kept' })
    expect(trail.rounds[0]!.candidates.find((entry) => entry.role === 'best')).toMatchObject({
      name: 'No change',
      check: { passed: true }
    })
    expect(trail.best).toMatchObject({ round: 0, name: 'No change' })
    expect(trail.stop).toBe('plateau')
    expect(plan.calls.some((call) => call.jev || call.stepId === 'judge')).toBe(false)
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toMatch(/^No change: your code as it is now/)
    expect(plan.outcome?.final?.markdown).toContain('No version beat your code as it is')
  })

  it('makes a change that passes where the code fails the best, and improves on it next', () => {
    const spec = improve()
    // Its own change: under rules 3 a change already checked reuses that result.
    const plan = drive(
      spec,
      (call) =>
        call.stepId === 'improve' && !call.check && call.round === 1 && call.agentIndex === 1
          ? text('Round 1 change 1: PASS\n```diff\n-a\n+c\n```')
          : answer(false)(call),
      RULES_2
    )
    const trail = plan.loop!.improve!
    expect(trail.rounds[0]).toMatchObject({
      mode: 'first',
      result: 'new-best',
      judgedBy: ['check']
    })
    expect(trail.rounds[1]).toMatchObject({ mode: 'improve', result: 'kept' })
    const round2 = plan.calls.find((call) => call.id === 'improve/r2/a0')!
    expect(round2.prompt).toContain('The best version so far')
    expect(round2.prompt).toContain('Round 1 change 1: PASS')
    expect(plan.outcome?.final?.markdown).toMatch(/^Round 1 change 1: PASS/)
  })

  it('tells the judges a version is a change and "No change" keeps the code', () => {
    const judged: GraphCall[] = []
    // Both pass and print no score, so the check cannot tell them apart.
    drive(
      improve(CODE, 1),
      (call) => {
        if (call.check) {
          return { markdown: 'check', passed: true, detail: 'ok' }
        }
        if (call.jev || call.stepId === 'judge') {
          judged.push(call)
          return { markdown: 'FINAL RANKING:\n1. Response A\n2. Response B' }
        }
        return text('A change\n```diff\n-a\n+b\n```')
      },
      RULES_2
    )
    const jev = judged.find((call) => call.jev)!
    expect(jev.jev!.task).toContain('Every version is a change to the code, shown as a diff')
    expect(jev.jev!.candidates.map((entry) => entry.markdown)).toContain(
      'No change: your code as it is now, with nothing applied.'
    )
  })

  it('never points a different approach at a best version it does not show while "No change" holds', () => {
    const spec = improve(CODE, 3)
    spec.repeat = { ...spec.repeat!, explore: 'normal' }
    const plan = drive(spec, answer(true), RULES_2)
    expect(plan.loop?.improve?.rounds.map((round) => round.mode)).toEqual(['first', 'divergent'])
    const explorer = plan.calls.find((call) => call.id === 'improve/r1/a2')!.prompt
    const divergent = plan.calls.find((call) => call.id === 'improve/r2/a0')!.prompt
    expect(divergent).toContain('The changes tried so far have not beaten the code as it is now.')
    expect(explorer).toContain('Change the code with a substantially different approach')
    for (const prompt of [explorer, divergent]) {
      expect(prompt).not.toMatch(/best version below|The best version so far/)
    }
    // The person's own wording still wins.
    spec.repeat = { ...spec.repeat, prompts: { divergent: 'Try something else entirely.' } }
    const own = drive(spec, answer(true), RULES_2)
    expect(own.calls.find((call) => call.id === 'improve/r2/a0')!.prompt).toContain(
      'Try something else entirely.'
    )
  })

  it('counts the check of "No change" as one host call more', () => {
    expect(planWorkflowCalls(improve()).hostTotal).toBe(4 * 2 + 1)
    const plain = improve({ command: 'npm test', cases: ['a'] })
    expect(planWorkflowCalls(plain).hostTotal).toBe(4 * 2)
  })

  it('runs changes to the code only under rules 2, from a saved commit', () => {
    const spec = improve()
    expect(graphImproveChangesCode({ spec, improveRules: IMPROVE_RULES })).toBe(true)
    expect(graphImproveChangesCode({ spec })).toBe(false)
    expect(() => assertImproveReplaySupported(spec, { host: { improveRules: 1 } })).toThrow(
      "can't replay them"
    )
    expect(() => assertImproveReplaySupported(spec, { host: { improveRules: 2 } })).toThrow(
      'no saved commit'
    )
    expect(() =>
      assertImproveReplaySupported(spec, {
        host: { improveRules: 2, checkSource: { sourceBase: 'a'.repeat(40) } }
      })
    ).not.toThrow()
  })
})
