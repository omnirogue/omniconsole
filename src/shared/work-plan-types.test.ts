import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_ACTION_TEMPLATES,
  SESSION_ACTION_PRESET_INSTRUCTIONS,
  SESSION_ACTION_PRESET_LABELS
} from './session-action-presets'
import {
  WORK_PLAN_MAX_REVIEW_ROUNDS,
  WORK_PLAN_REVIEW_KINDS,
  WORK_PLAN_REVIEW_STOP_RULES,
  WORK_PLAN_ROLES,
  workPlanOutcomeOf,
  WORK_PLAN_ROLE_PRESET,
  workPlanNodeSeatCount,
  workPlanSeatTotal,
  workPlanStageCount,
  type WorkPlanWorkerNode
} from './work-plan-types'
import {
  CONSOLE_WORKFLOW_LOOP_MAX_ROUNDS,
  consoleWorkflowLoopKind,
  consoleWorkflowLoopStopRule
} from './console-workflow-loop'
import { workPlanNodeInstruction } from './work-plan-instruction'
import { samWorkPlan } from './__fixtures__/work-plan/sal-work-plan'
import { councilWorkPlan } from './__fixtures__/work-plan/council-work-plan'

describe('work plan roles', () => {
  it.each(WORK_PLAN_ROLES)(
    'gives %s a preset with a label, a template and a non-empty default instruction',
    (role) => {
      const presetId = WORK_PLAN_ROLE_PRESET[role]
      expect(presetId).toBeTruthy()
      expect(SESSION_ACTION_PRESET_LABELS[presetId]).toBeTruthy()
      // Why non-empty: `agentStep` falls back to this text, and a step with an empty prompt is
      // dropped by the chain normalizer without a word.
      expect(SESSION_ACTION_PRESET_INSTRUCTIONS[presetId].trim()).not.toBe('')
      expect(DEFAULT_SESSION_ACTION_TEMPLATES[presetId]).toContain('{{objective}}')
    }
  )

  // The host appends ONE filled envelope to every verdict-emitting seat's brief
  // (`buildSessionVerdictInstructions`). A preset that also carried its own shape would put two
  // payloads in one brief, and a report answering both ends in two markers — the forgery shape the
  // parser refuses. So these two rows now assert the opposite of what they asserted before.
  it('asks the judge to rank by the exact candidate ids, and leaves the envelope to the host', () => {
    const judge = SESSION_ACTION_PRESET_INSTRUCTIONS.judge
    expect(judge).toContain('candidate ids you were given')
    expect(judge).toContain('rank')
    expect(judge).not.toContain('OMNI_VERDICT')
    const template = DEFAULT_SESSION_ACTION_TEMPLATES.judge
    expect(template).toContain('candidate ids you were given')
    expect(template).not.toContain('OMNI_VERDICT')
  })

  it('asks the critique to name what blocks, and leaves the envelope to the host', () => {
    expect(SESSION_ACTION_PRESET_INSTRUCTIONS.critique).toContain('whether anything blocks')
    expect(SESSION_ACTION_PRESET_INSTRUCTIONS.critique).not.toContain('OMNI_VERDICT')
    expect(DEFAULT_SESSION_ACTION_TEMPLATES.critique).not.toContain('OMNI_VERDICT')
  })

  it.each(['judge', 'critique', 'verify', 'review'] as const)(
    'leaves no verdict marker in the %s preset for the host suffix to collide with',
    (preset) => {
      expect(SESSION_ACTION_PRESET_INSTRUCTIONS[preset]).not.toContain('OMNI_VERDICT')
      expect(DEFAULT_SESSION_ACTION_TEMPLATES[preset]).not.toContain('OMNI_VERDICT')
    }
  )
})

describe('work plan shape arithmetic', () => {
  it('counts a review node as its reviewers per round plus the repairs between them', () => {
    const verify = samWorkPlan().nodes.find((node) => node.id === 'verify')!
    expect(workPlanNodeSeatCount(verify)).toBe(7)
  })

  it("folds Sal's example into six stages and sixteen seats", () => {
    const plan = samWorkPlan()
    expect(workPlanStageCount(plan)).toBe(6)
    expect(workPlanSeatTotal(plan)).toBe(16)
  })

  it('folds a council into four stages: answers, critiques, judge, winner', () => {
    const plan = councilWorkPlan()
    expect(workPlanStageCount(plan)).toBe(4)
    expect(workPlanSeatTotal(plan)).toBe(8)
  })
})

describe('what a node runs with', () => {
  it('states the transform against the outcome, not against the prompt', () => {
    const plan = samWorkPlan()
    const research = plan.nodes.find((node) => node.id === 'research')!
    const instruction = workPlanNodeInstruction(plan, research)
    expect(instruction).toContain('the page states the offer and the price')
    expect(instruction).toContain('the page file is in the workspace')
  })

  it('falls back to the plain instruction when the plan only has a title', () => {
    const plan = samWorkPlan()
    const titleOnly = { ...plan, outcome: { ...plan.outcome, doneWhen: [] } }
    const research = plan.nodes.find((node) => node.id === 'research')!
    expect(workPlanNodeInstruction(titleOnly, research)).toBe(
      'Research this further using the current work and context and return your findings.'
    )
  })

  it('fills the outcome into whatever the person typed, and leaves no placeholder behind', () => {
    const plan = samWorkPlan()
    const base = plan.nodes.find(
      (node): node is WorkPlanWorkerNode => node.id === 'synthesis' && node.kind === 'worker'
    )!
    expect(
      workPlanNodeInstruction(plan, {
        ...base,
        instruction: 'Fold the findings into "{{outcome.title}}".'
      })
    ).toBe('Fold the findings into "Ship the launch page".')
    const titleOnly = { ...plan, outcome: { ...plan.outcome, doneWhen: [] } }
    for (const role of WORK_PLAN_ROLES) {
      const node: WorkPlanWorkerNode = { ...base, role, instruction: '' }
      expect(workPlanNodeInstruction(plan, node)).not.toContain('{{')
      expect(workPlanNodeInstruction(titleOnly, node)).not.toContain('{{')
    }
  })
})

describe('the outcome has one reader', () => {
  it('is resolved through workPlanOutcomeOf, so attaching a plan later changes one place', () => {
    const plan = samWorkPlan()
    expect(workPlanOutcomeOf(plan)).toBe(plan.outcome)
    // Why a source scan: when the Outcome moves out of the plan, one accessor changes and every
    // rule keeps working. A rule that reached into the field directly would silently read a stale
    // snapshot instead of the Outcome it serves.
    const leaks = readdirSync(__dirname)
      .filter((name) => name.startsWith('work-plan-') && name.endsWith('.ts'))
      .filter((name) => !name.endsWith('.test.ts') && name !== 'work-plan-types.ts')
      .filter((name) => readFileSync(join(__dirname, name), 'utf8').includes('plan.outcome'))
    expect(leaks).toEqual([])
  })

  it('can name the Task container it is attached to, and needs none', () => {
    const plan = samWorkPlan()
    expect(workPlanOutcomeOf(plan).taskRef).toBeUndefined()
    const attached = {
      ...plan,
      outcome: { ...plan.outcome, taskRef: 'btk_9fA2', outcomeId: 'ship', revision: 3 }
    }
    expect(workPlanOutcomeOf(attached).taskRef).toBe('btk_9fA2')
    expect(workPlanOutcomeOf(attached).doneWhen).toEqual(plan.outcome.doneWhen)
  })
})

describe('a loop says the same words as the hub', () => {
  it('takes its kind, its stop rule and its round cap from the console loop schema', () => {
    // Why identity and not equality: a parallel list drifts, and then a work plan loop and a
    // card-attached hub loop mean different things by the same word.
    expect(WORK_PLAN_REVIEW_KINDS).toBe(consoleWorkflowLoopKind.options)
    expect(WORK_PLAN_REVIEW_STOP_RULES).toBe(consoleWorkflowLoopStopRule.options)
    expect(WORK_PLAN_MAX_REVIEW_ROUNDS).toBe(CONSOLE_WORKFLOW_LOOP_MAX_ROUNDS)
    expect([...WORK_PLAN_REVIEW_KINDS]).toEqual(['gap', 'review', 'adversarial'])
    expect([...WORK_PLAN_REVIEW_STOP_RULES]).toEqual([
      'all_gaps_closed',
      'zero_blockers',
      'max_rounds'
    ])
  })
})
