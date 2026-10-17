import { createWorkflowProgramContext } from '../workflow-program-context'
import { runWorkflowGraphProgram } from './graph-program'
import { createHash } from 'node:crypto'
import { describeWorkflow, planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { describe, expect, it } from 'vitest'
import type {
  WorkflowImprovePrompts,
  WorkflowRoute,
  WorkflowSpec
} from '../../../../shared/workflow-graph'
import { workflowSetImprove } from '../../../../shared/workflow-graph-improve'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WORKFLOW_IMPROVE_DEFAULT_PROMPTS } from '../../../../shared/workflow-improve-prompts'
import { graphJudgingEntries } from './graph-judging-record'
import { IMPROVE_RULES } from './graph-improve-rules'
import type { GraphCall, GraphConfig } from './graph-plan-types'
import { configFor, drive, task, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']
const FACTS = 'State only facts the task and the material above give'

function improve(prompts?: WorkflowImprovePrompts, candidates = 1): WorkflowSpec {
  const spec = workflowSetImprove(workflowTemplate('improve', ROUTES), { candidates }, ROUTES)
  return { ...spec, repeat: { ...spec.repeat!, maxRounds: 2, ...(prompts ? { prompts } : {}) } }
}

/** Improvers write "v<round>.<agent>"; JEV prefers the higher number. */
function answer(call: GraphCall) {
  if (call.jev) {
    const ordered = [...call.jev.candidates].sort(
      (left, right) =>
        Number(right.markdown.replace(/\D/g, '')) - Number(left.markdown.replace(/\D/g, ''))
    )
    return text(
      `FINAL RANKING:\n${ordered.map((entry, i) => `${i + 1}. ${entry.label}`).join('\n')}`
    )
  }
  return call.stepId === 'improve' ? text(`v${call.round}.${call.agentIndex}`) : undefined
}

const promptOf = (plan: ReturnType<typeof drive>, id: string) =>
  plan.calls.find((call) => call.id === id)!.prompt

describe("Improve's prompts", () => {
  it('asks every version, from the first, to state only facts the task gives', () => {
    const plan = drive(improve(), answer)
    for (const id of ['improve/r1/a0', 'improve/r2/a0']) {
      expect(promptOf(plan, id)).toContain('Rules for every version:')
      expect(promptOf(plan, id)).toContain(FACTS)
    }
    expect(promptOf(plan, 'improve/r1/a0')).toContain(WORKFLOW_IMPROVE_DEFAULT_PROMPTS.first)
    expect(promptOf(plan, 'improve/r2/a0')).toContain(WORKFLOW_IMPROVE_DEFAULT_PROMPTS.improve)
  })

  it("uses the person's own wording where they changed it, and the built-in wording elsewhere", () => {
    const plan = drive(
      improve({
        improve: 'Rewrite it for a ten-year-old reader.',
        rules: '- Keep every sentence under twelve words.'
      }),
      answer
    )
    const first = promptOf(plan, 'improve/r1/a0')
    expect(first).toContain(WORKFLOW_IMPROVE_DEFAULT_PROMPTS.first)
    expect(first).toContain('- Keep every sentence under twelve words.')
    expect(first).not.toContain(FACTS)
    const second = promptOf(plan, 'improve/r2/a0')
    expect(second).toContain('Rewrite it for a ten-year-old reader.')
    expect(second).not.toContain(WORKFLOW_IMPROVE_DEFAULT_PROMPTS.improve)
  })

  it('still tells an explorer to develop the alternative it is shown, whatever its wording', () => {
    const plan = drive(improve({ explore: 'Try something bold.' }, 3), answer)
    const explore = promptOf(plan, 'improve/r2/a2')
    expect(explore).toContain('Try something bold.')
    expect(explore).toContain('A promising alternative approach')
    expect(explore).toContain('develop it into your version')
  })

  it('keeps only real changes of wording, and only for a workflow that improves in rounds', () => {
    const read = normalizeWorkflowSpec(
      improve({
        first: `  ${WORKFLOW_IMPROVE_DEFAULT_PROMPTS.first}  `,
        improve: '  Be bolder.\n',
        explore: '   ',
        ...({ unknown: 'ignored' } as object)
      })
    )
    expect(read.repeat?.prompts).toEqual({ improve: 'Be bolder.' })
    const untouched = normalizeWorkflowSpec(improve())
    expect(untouched.repeat && 'prompts' in untouched.repeat).toBe(false)
    const review = normalizeWorkflowSpec({
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft' },
        { id: 'critic', kind: 'review', title: 'Critic', inputs: ['draft'] }
      ],
      repeat: { do: 'draft', review: 'critic', until: 'approved', prompts: { rules: 'x' } }
    })
    expect(review.repeat && 'prompts' in review.repeat).toBe(false)
  })

  it('records which instructions a run reworded, so their results can be compared', () => {
    const spec = improve({ rules: '- Keep it short.' }, 2)
    const plan = drive(spec, answer)
    const record = graphJudgingEntries(configFor(spec), task, plan, 'run-1', 1)
    expect(record.length).toBeGreaterThan(0)
    expect(record[0]!.prompts).toMatchObject({ custom: ['rules'] })
    const plain = graphJudgingEntries(
      configFor(improve(undefined, 2)),
      task,
      drive(improve(undefined, 2), answer),
      'run-2',
      1
    )
    expect(plain[0] && 'prompts' in plain[0]).toBe(false)
  })
})

describe('Council final check planning and replay', () => {
  it('preserves every legacy Council call prompt byte for byte', () => {
    const { finalCheck: _check, ...legacy } = workflowTemplate('council', [
      'claude',
      'codex',
      'grok'
    ])
    expect(normalizeWorkflowSpec(legacy).finalCheck).toBeUndefined()
    const plan = drive(legacy, (call) =>
      call.stepId === 'answer'
        ? text(`Opinion ${call.agentIndex}`)
        : call.stepId === 'chair'
          ? text('Chair answer')
          : text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C')
    )
    const digest = createHash('sha256')
      .update(JSON.stringify(plan.calls.map((call) => [call.id, call.prompt])))
      .digest('hex')
    // Measured on main-next 2a0de49389f75257e6087beaae47d21c05aa474e before implementation, not invented.
    expect(digest).toBe('85349776582c807f0a3592c973cebafdc3873be1132c3ba2aa58e45a94b8f981')
    expect(plan.outcome?.final?.markdown).toBe('Chair answer')
    // planWorkflowCalls must stay an upper bound for a legacy spec with finalCheck removed too.
    expect(plan.calls.filter((call) => !call.jev).length).toBeLessThanOrEqual(
      planWorkflowCalls(legacy).total
    )
  })

  it('opts in only Council, freezes the references, bounds calls and describes the check', () => {
    const spec = workflowTemplate('council', ['claude', 'codex', 'grok'])
    expect(normalizeWorkflowSpec(spec).finalCheck).toEqual({ rank: 'rank', chair: 'chair' })
    expect(workflowTemplate('improve').finalCheck).toBeUndefined()
    expect(planWorkflowCalls(spec)).toEqual({
      total: 10,
      agentTotal: 10,
      hostTotal: 0,
      perStep: { answer: 3, rank: 6, chair: 1 }
    })
    expect(describeWorkflow(spec)).toContain(
      "A final blind comparison checks the chairman's answer against the best first opinion and shows the first opinion only if it is judged better."
    )
  })
})

it('keeps the chair when the final check judge and model calls throw', async () => {
  const spec = workflowTemplate('council', ['claude', 'codex', 'grok'])
  const context = createWorkflowProgramContext({
    agent: async (call) => {
      if (call.id.startsWith('rank/r2/')) {
        throw new Error('judge unavailable')
      }
      // Round one's peer ranking needs a real ballot, so the run reaches round two for the
      // check's own failure, never because round one's rank step could not be parsed.
      if (call.id.startsWith('rank/')) {
        return text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C')
      }
      return text(call.id.startsWith('chair') ? 'Chair answer' : 'First opinion')
    },
    phase: () => {},
    log: () => {},
    guard: () => {},
    isFatal: () => false
  })
  const result = await runWorkflowGraphProgram(
    context,
    {
      ...configFor(spec),
      judgeWithJev: async (call) => {
        if (call.round === 2) {
          throw new Error('JEV unavailable')
        }
        return { value: text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C') }
      }
    },
    task
  )
  expect(result.final.markdown).toBe(
    "Chair answer\n\nThe final check could not run, so the chairman's answer is shown unchecked."
  )
  expect(result.gaps.at(-1)).toBe(
    "The final check could not run, so the chairman's answer is shown unchecked."
  )
})

it('reaches but never exceeds the call bound with model judges at both stages', () => {
  const spec = workflowTemplate('council', ['claude', 'codex', 'grok'])
  const plan = drive(spec, (call) =>
    call.jev
      ? undefined
      : call.stepId === 'rank'
        ? text(
            `FINAL RANKING:\n1. Response A\n2. Response B${call.round === 1 ? '\n3. Response C' : ''}`
          )
        : text(call.stepId === 'chair' ? 'Chair answer' : 'First opinion')
  )
  expect(plan.outcome?.state).toBe('completed')
  expect(plan.calls.filter((call) => !call.jev)).toHaveLength(planWorkflowCalls(spec).total)
})

it('breaks a peer tie by label, keeps the comparison blind, and rotates model presentation', () => {
  const spec = workflowTemplate('council', ['claude', 'codex', 'grok'])
  spec.steps[0].agents = spec.steps[0].agents.map(() => ({ route: 'claude' }))
  const ballot = (labels: string[]) =>
    text(`FINAL RANKING:\n${labels.map((label, i) => `${i + 1}. Response ${label}`).join('\n')}`)
  const plan = drive(spec, (call) => {
    if (call.stepId === 'answer') {
      return text(`Opinion ${call.agentIndex}`)
    }
    if (call.stepId === 'chair') {
      return text('Synthesis')
    }
    if (call.round === 1) {
      if (call.jev) {
        return undefined
      }
      const labels = ['A', 'B', 'C']
      return ballot([...labels.slice(call.agentIndex), ...labels.slice(0, call.agentIndex)])
    }
    return { ...ballot(['A', 'B']), ...(call.jev ? { unsure: true } : {}) }
  })
  expect(plan.runs.rank[0].standings?.map((row) => row.place)).toEqual([1, 1, 1])
  expect(plan.outcome?.final?.markdown).toMatch(/^Opinion 0\n/)
  const check = plan.calls.find((call) => call.id === 'rank/r2/jev')!
  expect(check.jev?.candidates).toEqual([
    { label: 'Response A', markdown: 'Opinion 0' },
    { label: 'Response B', markdown: 'Synthesis' }
  ])
  const models = plan.calls.filter((call) => call.round === 2 && !call.jev)
  for (const call of models) {
    expect(call.dependencies).toEqual(['chair/a0'])
    expect(call.prompt).not.toMatch(/Claude|Codex|chairman|incumbent/i)
  }
  expect(models[1].prompt.indexOf('Response B:')).toBeLessThan(
    models[1].prompt.indexOf('Response A:')
  )
})

describe('Improve rules 3: what to fix first, and what not to repeat', () => {
  const RULES_3: Partial<GraphConfig> = { access: 'workspace-read', improveRules: IMPROVE_RULES }
  const DIRECTIVE =
    'Focus on fixing the weakest criterion and check failures first. Do not repeat mutations listed under Tried & Rejected.'
  function threeRounds(repeat: Partial<NonNullable<WorkflowSpec['repeat']>> = {}): WorkflowSpec {
    const spec = improve()
    return { ...spec, repeat: { ...spec.repeat!, maxRounds: 3, ...repeat } }
  }

  /** JEV keeps v1 every round, by rubric scores: weakest at "Backed by proof", then "Clear". */
  function keepsFirst(call: GraphCall) {
    if (!call.jev) {
      return answer(call)
    }
    const ordered = [...call.jev.candidates].sort(
      (left, right) => Number(right.markdown === 'v1.0') - Number(left.markdown === 'v1.0')
    )
    const scores = (score: number) =>
      Object.fromEntries(call.jev!.candidates.map((candidate) => [candidate.label, score]))
    return {
      markdown: `FINAL RANKING:\n${ordered.map((entry, i) => `${i + 1}. ${entry.label}`).join('\n')}`,
      judgment: {
        method: 'rubric',
        criteria: [
          { id: 'clear', label: 'Clear', scores: scores(3.5) },
          { id: 'proof', label: 'Backed by proof', scores: scores(1) },
          { id: 'complete', label: 'Complete', scores: scores(4) }
        ]
      }
    }
  }

  it("names the best version's weakest criteria and every version the judges rejected", () => {
    const plan = drive(threeRounds(), keepsFirst, RULES_3)
    const third = promptOf(plan, 'improve/r3/a0')
    expect(third).toContain(DIRECTIVE)
    expect(third).toContain(
      "The best version's weakest criteria (JEV rubric score, 0 to 4):\n- Backed by proof: 1.0\n- Clear: 3.5"
    )
    expect(third).not.toContain('- Complete: 4.0')
    expect(third).toContain('Tried & Rejected in Previous Rounds:')
    expect(third).toMatch(/round 2: v2\.0 \(the judges preferred .+ \(round 1\)\)/)
    // Round two had nothing judged before it, so it has nothing to reflect on.
    expect(promptOf(plan, 'improve/r2/a0')).not.toContain('Tried & Rejected')
  })

  /** v2 fails its check with `detail`; v1 passes, so the best version's own output is never shown. */
  function failsRoundTwo(detail: string, extra: Record<string, unknown> = {}) {
    return drive(
      threeRounds({ explore: 'low', check: { command: 'npm test' } }),
      (call) => {
        if (call.check) {
          const failed = call.check.candidate.startsWith('v2')
          return failed
            ? { markdown: 'check', passed: false, detail, ...extra }
            : { markdown: 'check', passed: true, detail: 'ok' }
        }
        return answer(call)
      },
      RULES_3
    )
  }

  it("names how a rejected version's check failed in codes and counts, never its output", () => {
    const plan = failsRoundTwo('AssertionError: expected 2, got 3', {
      cases: { total: 3, passed: 1, unavailable: 1 },
      exits: ['process.exit']
    })
    expect(plan.loop?.improve?.rounds[1]).toMatchObject({ result: 'kept', judgedBy: ['check'] })
    const third = promptOf(plan, 'improve/r3/a0')
    expect(third).toContain(DIRECTIVE)
    expect(third).toContain(
      'round 2: v2.0 (failed the check (1 of 3 cases pass)) [failure: check_failed; check: early_exit_flagged; cases: 1 of 3 passed, 1 could not run; exits: process.exit]'
    )
    expect(third).not.toContain('AssertionError')
    expect(third).not.toContain('the end of its output')
  })

  it("reads why a change was not tested from the app's own words, and nothing after them", () => {
    const plan = failsRoundTwo(
      'Not tested: the diff does not apply to your code as it is.\nerror: patch failed: src/app.ts:7'
    )
    const third = promptOf(plan, 'improve/r3/a0')
    expect(third).toContain('[failure: check_failed; check: patch_apply_failed]')
    expect(third).not.toContain('patch failed: src/app.ts')
  })

  it('never sends customer data from a check output to the next improvers', () => {
    const SECRETS = ['jane.doe@example.com', '4242 4242 4242 4242', 'sk_live_51Hx9Secret']
    const plan = failsRoundTwo(
      `FAIL tests/billing.test.ts\nExpected customer ${SECRETS[0]} card ${SECRETS[1]}\nkey=${SECRETS[2]}`
    )
    const third = promptOf(plan, 'improve/r3/a0')
    expect(third).toContain('Tried & Rejected in Previous Rounds:')
    expect(third).toContain('[failure: check_failed; check: check_command_failed]')
    for (const secret of SECRETS) {
      expect(third).not.toContain(secret)
    }
    // Nor does any other improver prompt in the run.
    const prompts = plan.calls.filter((call) => call.stepId === 'improve' && !call.check)
    expect(prompts.length).toBeGreaterThan(0)
    for (const call of prompts) {
      for (const secret of SECRETS) {
        expect(call.prompt).not.toContain(secret)
      }
    }
  })

  it('leaves prompts of runs admitted under older rules as they were', () => {
    const plan = drive(threeRounds(), keepsFirst, { ...RULES_3, improveRules: 2 })
    expect(promptOf(plan, 'improve/r3/a0')).not.toContain('Tried & Rejected')
    expect(promptOf(plan, 'improve/r3/a0')).not.toContain('weakest criteria')
  })
})
