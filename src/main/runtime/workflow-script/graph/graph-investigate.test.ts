import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { describeWorkflow, planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import type { GraphEvidenceCheck } from './graph-evidence-check'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

const spec = () => workflowTemplate('investigate', ['claude', 'codex', 'grok'])
const SPLIT =
  '## Question\nDid the cache get slower?\n\n## Angle 1\nThe code.\n\n## Angle 2\nThe history.\n\n## Angle 3\nThe docs.'
const SYNTHESIS = 'SYNTHESIS: the cache got slower because the index was dropped.'

/** Each investigator reports its own claims, one of them quoted at a path:line. */
const claims = (agent: number) => [
  {
    title: `Claim ${agent}A: the cache index was removed`,
    detail: `Investigator ${agent} saw the index dropped in the cache module.`,
    location: `src/cache${agent}.ts:${10 + agent}`,
    severity: 'none',
    excerpt: `const index${agent} = null`,
    trigger: 'always'
  },
  {
    title: `Claim ${agent}B: the design doc promises a warm start`,
    detail: `Investigator ${agent} read the design notes on warm starts.`,
    location: '',
    severity: 'none',
    excerpt: '',
    trigger: 'a cold start'
  }
]

function checks(call: GraphCall): Record<string, GraphEvidenceCheck> {
  return Object.fromEntries(
    call.evidence!.items.map((item): [string, GraphEvidenceCheck] => [
      item.key,
      item.file === 'src/cache1.ts'
        ? { status: 'unreadable' }
        : { status: 'found', line: item.line, context: `${item.line} | ${item.excerpt}` }
    ])
  )
}

function answer(final = (call: GraphCall) => text(`The answer.\n${call.id}`)) {
  return (call: GraphCall): unknown => {
    if (call.evidence) {
      return { checks: checks(call) }
    }
    switch (call.stepId) {
      case 'split':
        return text(SPLIT)
      case 'investigate':
        return { items: claims(call.agentIndex) }
      case 'synthesis':
        return text(SYNTHESIS)
      case 'factcheck':
        return text(`Checked.\nVERDICT: ${call.prompt.includes('Claim 2A') ? 'FAIL' : 'PASS'}`)
      case 'skeptic':
        return text('It overreaches on warm starts.\nVERDICT: FAIL')
      default:
        return final(call)
    }
  }
}

const prompts = (calls: GraphCall[], step: string) =>
  calls.filter((call) => call.stepId === step && /\/a\d+$/.test(call.id)).map((call) => call.prompt)

describe('Investigate runs end to end', () => {
  it('hands the synthesis every investigator claim and the checkers the synthesis', () => {
    const plan = drive(spec(), answer(), { access: 'workspace-read' })
    expect(plan.outcome?.state).toBe('completed')
    const [synthesis] = prompts(plan.calls, 'synthesis')
    for (const agent of [0, 1, 2]) {
      expect(synthesis).toContain(`Claim ${agent}A: the cache index was removed`)
      expect(synthesis).toContain(`Claim ${agent}B: the design doc promises a warm start`)
    }
    expect(synthesis).toContain('## Angle 3')
    const checks = prompts(plan.calls, 'factcheck')
    expect(checks.length).toBeGreaterThanOrEqual(6)
    expect(checks.every((prompt) => prompt.includes(SYNTHESIS))).toBe(true)
    // The fact-checker starts from the app's quote check.
    const quoted = checks.find((prompt) => prompt.includes('Claim 0A'))!
    expect(quoted).toContain('App check: the quote was found in the file at line 10')
    const unread = checks.find((prompt) => prompt.includes('Claim 1A'))!
    expect(unread).toContain('the file could not be read, so the quote is unchecked')
    const [skeptic] = prompts(plan.calls, 'skeptic')
    expect(skeptic).toContain(SYNTHESIS)
    expect(skeptic).toContain('Take this angle: skeptic.')
    expect(plan.calls.filter((call) => call.evidence)).toHaveLength(1)
  })

  it('ends in the table, holding the writer to the fact-check', () => {
    const final = (call: GraphCall) => {
      const key = (title: string) =>
        new RegExp(`\\[(investigate\\.r1\\.\\d+)\\] \\*\\*${title}`).exec(call.prompt)?.[1] ?? ''
      const rows = [
        {
          claim: 'Index removed',
          status: 'confirmed',
          evidence: 'src/cache0.ts:10',
          key: key('Claim 0A')
        },
        {
          claim: 'Refuted index',
          status: 'confirmed',
          evidence: 'src/cache2.ts:12',
          key: key('Claim 2A')
        },
        { claim: 'Warm start', status: 'confirmed', evidence: '', key: key('Claim 0B') }
      ]
      return text(`## Answer\nSlower.\n\n\`\`\`claims\n${JSON.stringify(rows)}\n\`\`\``)
    }
    const plan = drive(spec(), answer(final), { access: 'workspace-read' })
    const answerPrompt = prompts(plan.calls, 'answer')[0]!
    expect(answerPrompt).toContain('append exactly one fenced block tagged `claims`')
    expect(answerPrompt).toMatch(/\[investigate\.r1\.\d+\]/)
    const markdown = plan.outcome!.final!.markdown
    expect(markdown).not.toContain('```claims')
    expect(markdown).toContain('| Index removed | Confirmed | src/cache0.ts:10 |')
    expect(markdown).toContain(
      '| Refuted index | Open (was marked confirmed; the fact-check did not confirm it) |'
    )
    expect(markdown).toContain('| Warm start | Open (was marked confirmed; it names no evidence) |')
    expect(plan.outcome!.gaps).toEqual([])
  })

  it('falls back to the fact-check when the writer gives no table, and says so', () => {
    const plan = drive(spec(), answer(), { access: 'workspace-read' })
    const markdown = plan.outcome!.final!.markdown
    expect(markdown).toContain('## Confirmed, refuted and open')
    expect(markdown).toMatch(
      /\| Claim 0A: the cache index was removed \| Confirmed \| src\/cache0\.ts:10/
    )
    expect(markdown).toContain('| Claim 2A: the cache index was removed | Refuted |')
    expect(plan.outcome!.gaps).toContain(
      'Final answer gave no table of claims, so the table shows the fact-check as it came back.'
    )
  })

  it('stays within its call bound and reads back plainly', () => {
    const bound = planWorkflowCalls(spec())
    expect(bound.agentTotal).toBe(1 + 3 + 1 + (15 + 3 + 3) + 1 + 1)
    expect(bound.hostTotal).toBe(1)
    // Every claim failing its first check escalates as far as the bound allows.
    const worst = (call: GraphCall) =>
      call.stepId === 'factcheck' ? text('No.\nVERDICT: FAIL') : answer()(call)
    const many = (call: GraphCall) =>
      call.stepId === 'investigate'
        ? {
            items: [0, 1, 2, 3, 4].map((n) => ({
              ...claims(call.agentIndex)[0]!,
              title: `Distinct claim ${call.agentIndex}-${n} about part ${n * 7 + call.agentIndex}`,
              location: `src/part${call.agentIndex}${n}.ts:${n + 1}`
            }))
          }
        : worst(call)
    const plan = drive(spec(), many, { access: 'workspace-read' })
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.calls.filter((call) => call.stepId === 'factcheck' && !call.evidence)).toHaveLength(
      18
    )
    expect(plan.calls.length).toBeLessThanOrEqual(bound.total)
    expect(describeWorkflow(spec())).toEqual([
      'Split: 1 agent works.',
      'Investigate: 3 agents list items in parallel using Split.',
      'Synthesis: 1 agent writes the final answer using Split and Investigate.',
      'Fact-check: 1 agent reviews for each item from Investigate using Synthesis; the first reviewer is from another model family than the finder, and the other 1 agent join on up to 3 items a round that do not pass or are critical; when a first review gives no answer, an agent on another provider reviews the item instead, on up to 3 items a round.',
      'Skeptic: 1 agent reviews using Split and Investigate and Synthesis.',
      'Final answer: 1 agent writes the final answer with a table of confirmed, refuted and open claims using Synthesis and Fact-check and Skeptic; a claim stays open unless the fact-check it reads confirmed it and it names its evidence.',
      `Up to ${bound.agentTotal} agent calls.`
    ])
  })
})
