import { describe, expect, it } from 'vitest'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { workflowSetFind } from '../../../../shared/workflow-graph-find'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

function versions(results: { passed: boolean; score?: number }[], top?: number) {
  const spec = workflowSetFind(
    workflowTemplate('find', ROUTES),
    {
      versions: true,
      count: results.length,
      check: { command: 'node check.mjs {candidate}' },
      ...(top ? { top } : {})
    },
    ROUTES
  )
  return drive(spec, (call: GraphCall) => {
    if (call.check) {
      const index = Number(/\/a(\d+)\/check$/.exec(call.id)![1])
      return { ...results[index]!, detail: 'ok' }
    }
    if (call.screen) {
      return {
        markdown: 'screen',
        scores: Object.fromEntries(
          call.screen.candidates.map((candidate, n) => [candidate.id, 3 - n])
        ),
        criteria: [],
        unscored: []
      }
    }
    if (call.jev) {
      return text(
        `FINAL RANKING:\n${call.jev.candidates.map((entry, n) => `${n + 1}. ${entry.label}`).join('\n')}`
      )
    }
    return call.stepId === 'options' && !call.screen
      ? text(`Version ${call.agentIndex + 1} in full.`)
      : undefined
  })
}

describe("complete versions under the person's check", () => {
  it('lets the check decide when it leaves one version on top, and asks no judge', () => {
    const plan = versions([
      { passed: false },
      { passed: true, score: 5 },
      { passed: true, score: 9 }
    ])
    expect(plan.calls.filter((call) => call.check).map((call) => call.check!.command)).toEqual([
      'node check.mjs {candidate}',
      'node check.mjs {candidate}',
      'node check.mjs {candidate}'
    ])
    expect(plan.calls.some((call) => call.jev || call.screen)).toBe(false)
    expect(plan.find).toMatchObject({
      stage: 'done',
      decidedBy: ['check'],
      check: { checked: 3, passed: 2, unavailable: 0 }
    })
    expect(plan.find!.rows!.map((row) => [row.title.slice(0, 9), row.check])).toEqual([
      ['Version 3', { passed: true, score: 9 }],
      ['Version 2', { passed: true, score: 5 }],
      ['Version 1', { passed: false }]
    ])
    const report = plan.outcome!.final!.markdown
    expect(report).toContain(
      'Every version ran your check (`node check.mjs {candidate}`): 2 of 3 passed.'
    )
    expect(report).toContain('Your check left one version on top, so no judge was needed.')
  })

  it('sends the versions it cannot tell apart to the judges, and lists the rest after them', () => {
    const plan = versions([{ passed: false }, { passed: true }, { passed: true }])
    const final = plan.calls.find((call) => call.jev)!
    expect(final.jev!.candidates.map((entry) => entry.markdown)).toEqual([
      'Version 2 in full.',
      'Version 3 in full.'
    ])
    // The scripted judges keep the order they were shown, so Version 2 wins the final.
    expect(plan.find!.rows!.map((row) => row.title.slice(0, 9))).toEqual([
      'Version 2',
      'Version 3',
      'Version 1'
    ])
    expect(plan.find!.rows!.at(-1)!.check).toEqual({ passed: false })
  })

  it('says so when no version passes, and the judges choose among them all', () => {
    const plan = versions([{ passed: false }, { passed: false }])
    expect(plan.find).toMatchObject({ stage: 'done', check: { passed: 0 } })
    expect(plan.outcome!.gaps).toContain('No version passed your check.')
  })

  it("credits JEV's screen, not the check, when the check left several on top", () => {
    const plan = versions([{ passed: true }, { passed: true }, { passed: true }], 1)
    expect(plan.calls.some((call) => call.screen)).toBe(true)
    expect(plan.find!.decidedBy).toEqual(['screen'])
    expect(plan.outcome!.final!.markdown).not.toContain('Your check left one version on top')
  })

  it('names the gap without claiming judges when the scores alone decide', () => {
    const plan = versions([
      { passed: false, score: 1 },
      { passed: false, score: 3 },
      { passed: false, score: 2 }
    ])
    expect(plan.calls.some((call) => call.jev || call.screen)).toBe(false)
    expect(plan.find).toMatchObject({ decidedBy: ['check'] })
    expect(plan.find!.rows![0]!.title).toMatch(/^Version 2/)
    expect(plan.outcome!.gaps).toContain('No version passed your check.')
  })

  it('keeps a check only on complete versions', () => {
    const options = normalizeWorkflowSpec({
      ...workflowTemplate('find', ROUTES),
      find: { count: 40, top: 5, check: { command: 'rm -rf /' } }
    })
    expect(options.find).not.toHaveProperty('check')
  })
})
