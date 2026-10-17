import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { composeReviewStepInstructions } from '../../../../shared/review-rubrics'
import { LIBRARY_RUBRICS } from '../../../../shared/rubric-library'
import { workflowPatchStep } from '../../../../shared/workflow-graph-edit'
import {
  BEST_OF_N_ANGLES,
  BEST_OF_N_GENERATE_INSTRUCTION,
  workflowSetFind
} from '../../../../shared/workflow-graph-find'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

function find(change: Parameters<typeof workflowSetFind>[1] = {}): WorkflowSpec {
  return workflowSetFind(workflowTemplate('find', ROUTES), change, ROUTES)
}

// Distinct title words, so the list merger keeps every option apart.
const FRUITS = [
  ['apple', 'banana', 'cherry', 'damson'],
  ['elder', 'fig', 'grape', 'hazel']
]
const SCORES: Record<string, number> = {
  apple: 3.7,
  elder: 3.6,
  banana: 3.4,
  fig: 3.3,
  cherry: 3.1,
  grape: 3,
  damson: 2.8,
  hazel: 2.7
}
/** JEV's scripted score: by the fruit, or for "Idea 7.<n>" lower as n grows. */
const screenScore = (candidate: string) => {
  const word = /Idea (\w+)/.exec(candidate)?.[1] ?? ''
  return SCORES[word] ?? 4 - Number(/Idea \d+\.(\d+)/.exec(candidate)?.[1] ?? 0) * 0.3
}

type Answer = {
  screen?: (call: GraphCall) => unknown
  finalOrder?: (labels: { label: string; markdown: string }[]) => string[]
  models?: (call: GraphCall) => unknown
}

function answer(options: Answer = {}) {
  return (call: GraphCall) => {
    if (call.screen) {
      return (
        options.screen?.(call) ?? {
          markdown: 'screen',
          scores: Object.fromEntries(
            call.screen.candidates.map((candidate) => [candidate.id, screenScore(candidate.text)])
          ),
          criteria: [],
          unscored: []
        }
      )
    }
    if (call.jev) {
      const labels = call.jev.candidates
      const order = options.finalOrder?.(labels) ?? labels.map((entry) => entry.label).toReversed()
      return text(
        `FINAL RANKING:\n${order.map((label, index) => `${index + 1}. ${label}`).join('\n')}`
      )
    }
    if (call.stepId === 'options') {
      return {
        items: FRUITS[call.agentIndex]!.map((fruit) => ({
          title: `Idea ${fruit}`,
          detail: `Why the ${fruit} idea works.`,
          location: '',
          severity: 'none'
        }))
      }
    }
    return options.models?.(call)
  }
}

describe('Find the best', () => {
  it('comes up with options in batches, screens every one with JEV, and names the best', () => {
    const plan = drive(find({ count: 40 }), answer())
    const batches = plan.calls.filter((call) => call.stepId === 'options')
    expect(batches.map((call) => call.id)).toEqual(['options/a0', 'options/a1'])
    // Each batch looks from its own angle, so the options differ.
    expect(batches[0]!.prompt).not.toEqual(batches[1]!.prompt)
    const screen = plan.calls.find((call) => call.screen)!
    expect(screen.screen!.candidates).toHaveLength(8)
    // Only the overall top five reach the final.
    const final = plan.calls.find((call) => call.jev)!
    expect(final.jev!.candidates).toHaveLength(5)
    expect(plan.find).toMatchObject({ stage: 'done', pool: 8, scored: 8, unscored: 0 })
    expect(plan.find!.overall.map((pick) => pick.title)).toEqual([
      'Idea apple',
      'Idea elder',
      'Idea banana',
      'Idea fig',
      'Idea cherry'
    ])
    // The scripted final reverses the shown order, so the fifth finalist wins.
    expect(plan.find!.winner?.title).toBe('Idea cherry')
    expect(plan.find!.decidedBy).toEqual(['jev'])
    expect(plan.outcome).toMatchObject({ state: 'completed', gaps: [] })
    const report = plan.outcome!.final!.markdown
    expect(report).toContain('## Best option: Idea cherry')
    expect(report).toContain('## How this was found')
    // It brings back the best ten it has: the final's order first, then JEV's.
    expect(plan.find!.rows!.map((row) => [row.title, row.finalPlace ?? null, !!row.kept])).toEqual([
      ['Idea cherry', 1, true],
      ['Idea fig', 2, true],
      ['Idea banana', 3, true],
      ['Idea elder', 4, true],
      ['Idea apple', 5, true],
      ['Idea grape', null, true],
      ['Idea damson', null, true],
      ['Idea hazel', null, true]
    ])
    expect(report).toContain('## Top 8')
    expect(report).toContain(
      "Places 1 to 5 come from the final; the rest are in JEV's score order."
    )
  })

  it('brings back as many as the person keeps, whatever the size of the final', () => {
    const plan = drive(find({ count: 40, keep: 3 }), answer())
    expect(plan.find!.rows).toHaveLength(8)
    expect(plan.find!.rows!.filter((row) => row.kept).map((row) => row.title)).toEqual([
      'Idea cherry',
      'Idea fig',
      'Idea banana'
    ])
    const report = plan.outcome!.final!.markdown
    expect(report).toContain('## Top 3')
    expect(report).not.toContain('Places 1 to')
    // A run from before keeping existed brings back its finalists, as it did then.
    const before = normalizeWorkflowSpec({ ...find({ count: 40 }), find: { count: 40, top: 4 } })
    expect(before.find).toEqual({ count: 40, top: 4 })
    expect(drive(before, answer()).find!.rows!.filter((row) => row.kept)).toHaveLength(4)
  })

  it("chooses from the person's own list without coming up with any", () => {
    const items = Array.from({ length: 6 }, (_, n) => `Idea 7.${n + 1}`)
    const plan = drive(find({ items }), answer())
    expect(plan.calls.some((call) => call.stepId === 'options' && !call.screen)).toBe(false)
    expect(plan.calls.find((call) => call.screen)!.screen!.candidates).toHaveLength(6)
    expect(plan.find).toMatchObject({ stage: 'done', source: 'list', pool: 6 })
    expect(plan.outcome!.final!.markdown).toContain('You gave 6 options')
  })

  it("brings back the top options for each line of the person's rubric", () => {
    const spec = workflowPatchStep(
      find({ items: ['Idea 1.1', 'Idea 1.2', 'Idea 1.3'], top: 2 }),
      'judge',
      {
        instruction: '- Cheap to start\n- Fast to revenue'
      }
    )
    const plan = drive(
      spec,
      answer({
        screen: (call) => {
          const ids = call.screen!.candidates.map((candidate) => candidate.id)
          return {
            markdown: 'screen',
            scores: { [ids[0]!]: 3, [ids[1]!]: 2, [ids[2]!]: 1 },
            criteria: [
              {
                id: 'c1',
                label: 'Cheap to start',
                scores: { [ids[0]!]: 1, [ids[1]!]: 2, [ids[2]!]: 4 }
              },
              {
                id: 'c2',
                label: 'Fast to revenue',
                scores: { [ids[0]!]: 4, [ids[1]!]: 3, [ids[2]!]: 1 }
              }
            ],
            unscored: []
          }
        }
      })
    )
    expect(
      plan.find!.byCriterion.map((entry) => [
        entry.criterion,
        entry.picks.map((pick) => pick.title)
      ])
    ).toEqual([
      ['Cheap to start', ['Idea 1.3', 'Idea 1.2']],
      ['Fast to revenue', ['Idea 1.1', 'Idea 1.2']]
    ])
    expect(plan.outcome!.final!.markdown).toContain('## Top 2 for "Cheap to start"')
    // Every option keeps its score on each line, in the order of the lines.
    expect(plan.find!.criteria).toEqual(['Cheap to start', 'Fast to revenue'])
    expect(
      Object.fromEntries(plan.find!.rows!.map((row) => [row.title, [row.score, ...row.scores]]))
    ).toEqual({ 'Idea 1.1': [3, 1, 4], 'Idea 1.2': [2, 2, 3], 'Idea 1.3': [1, 4, 1] })
  })

  it('screens against a rubric from the library, and names it in the report', () => {
    const ads = LIBRARY_RUBRICS.find((entry) => entry.name === 'Ad copy')!
    const spec = workflowPatchStep(find({ count: 40 }), 'judge', {
      instruction: composeReviewStepInstructions({
        shared: { id: 'custom', name: ads.name, instructions: ads.instructions },
        perReviewer: [],
        focus: ''
      })
    })
    const plan = drive(
      spec,
      answer({
        screen: (call) => ({
          markdown: 'screen',
          scores: Object.fromEntries(
            call.screen!.candidates.map((candidate) => [candidate.id, screenScore(candidate.text)])
          ),
          criteria: [
            {
              id: 'c1',
              label: 'The first line stops',
              scores: Object.fromEntries(
                call.screen!.candidates.map((candidate) => [candidate.id, 2])
              )
            }
          ],
          unscored: []
        })
      })
    )
    // JEV reads the whole rubric, so each of its lines is a criterion with its own shortlist.
    expect(plan.calls.find((call) => call.screen)!.screen!.rubric).toContain('Rubric: Ad copy')
    expect(plan.find!.byCriterion.map((entry) => entry.criterion)).toEqual([
      'The first line stops the scroll for the target customer'
    ])
    expect(plan.outcome!.final!.markdown).toContain('against the Ad copy rubric')
  })

  it('goes straight to the final when every option fits in it', () => {
    const plan = drive(find({ items: ['Idea 1.1', 'Idea 1.2', 'Idea 1.3'] }), answer())
    expect(plan.calls.some((call) => call.screen)).toBe(false)
    expect(plan.find).toMatchObject({ stage: 'done', pool: 3 })
    expect(plan.find!.scored).toBeUndefined()
  })

  it('ends with the reason when JEV cannot screen, and runs no final', () => {
    const plan = drive(
      find({ count: 40 }),
      answer({ screen: () => ({ markdown: 'x', error: 'no TypeSafe API key (TYPESAFE_API_KEY)' }) })
    )
    expect(plan.calls.some((call) => call.jev)).toBe(false)
    expect(plan.outcome).toMatchObject({ state: 'failed' })
    expect(plan.outcome!.error).toContain('no TypeSafe API key')
  })

  it('leaves out options JEV could not score, and says so', () => {
    const plan = drive(
      find({ count: 40 }),
      answer({
        screen: (call) => {
          const [first, ...rest] = call.screen!.candidates
          return {
            markdown: 'screen',
            scores: Object.fromEntries(
              rest.map((candidate) => [candidate.id, screenScore(candidate.text)])
            ),
            criteria: [],
            unscored: [first!.id]
          }
        }
      })
    )
    expect(plan.find).toMatchObject({ scored: 7, unscored: 1 })
    expect(plan.find!.overall.map((pick) => pick.title)).not.toContain('Idea apple')
    // The results still list it, last and without a score.
    expect(plan.find!.rows!.at(-1)).toMatchObject({ title: 'Idea apple' })
    expect(plan.find!.rows!.at(-1)!.score).toBeUndefined()
    expect(plan.outcome!.gaps.join(' ')).toContain('JEV could not score 1 option')
  })

  it('keeps the highest screen score when no judge can vote in the final', () => {
    const plan = drive(find({ count: 40 }), (call) =>
      call.jev || (call.stepId === 'judge' && !call.screen) ? undefined : answer()(call)
    )
    expect(plan.find).toMatchObject({ stage: 'done', decidedBy: ['screen'] })
    expect(plan.find!.winner?.title).toBe('Idea apple')
    expect(plan.outcome!.gaps.join(' ')).toContain('highest JEV score stands')
  })

  it('judges complete versions blind, one from each model, and shows the best one whole', () => {
    const spec = find({ versions: true, count: 3 })
    const plan = drive(spec, (call) =>
      call.stepId === 'options' && !call.screen
        ? text(`Complete version ${call.agentIndex + 1}, written in full.`)
        : answer()(call)
    )
    // All three fit in the final, so there is no screen; judges read the versions, not the angles.
    expect(plan.calls.some((call) => call.screen)).toBe(false)
    expect(
      plan.calls.find((call) => call.jev)!.jev!.candidates.map((entry) => entry.markdown)
    ).toEqual([
      'Complete version 1, written in full.',
      'Complete version 2, written in full.',
      'Complete version 3, written in full.'
    ])
    expect(plan.find).toMatchObject({ stage: 'done', source: 'versions', pool: 3 })
    const report = plan.outcome!.final!.markdown
    expect(report).toContain(
      `## Best version: Version 3: ${BEST_OF_N_ANGLES[2]}\n\nComplete version 3, written in full.`
    )
    expect(report).toContain('3 complete versions came from')
    // The results keep every version whole.
    expect(plan.find!.rows!.map((row) => row.detail)).toContain(
      'Complete version 1, written in full.'
    )
  })

  it('switches between short options and complete versions', () => {
    const versions = find({ versions: true })
    expect(versions.find).toEqual({ count: 4, versions: true, top: 5, keep: 10 })
    const step = versions.steps.find((entry) => entry.id === 'options')!
    expect(step.list).toBeUndefined()
    expect(step.instruction).toBe(BEST_OF_N_GENERATE_INSTRUCTION)
    expect(step.agents.map((agent) => agent.angle)).toEqual(BEST_OF_N_ANGLES.slice(0, 4))
    expect(validateWorkflowSpec(versions, { available: ROUTES }).problems).toEqual([])
    expect(normalizeWorkflowSpec(versions).find).toEqual(versions.find)
    // One model call per version, so at most a step's agents.
    expect(workflowSetFind(versions, { count: 20 }, ROUTES).find!.count).toBe(8)
    const back = workflowSetFind(versions, { versions: false }, ROUTES)
    expect(back.find).toEqual({ count: 100, top: 5, keep: 10 })
    expect(back.steps.find((entry) => entry.id === 'options')!.list).toEqual({ maxItems: 20 })
    // The person's list is used as given, so nothing writes versions.
    expect(workflowSetFind(versions, { items: ['A', 'B'] }, ROUTES).find).not.toHaveProperty(
      'versions'
    )
  })

  it('reads its settings safely, and asks for two options when the list is short', () => {
    const read = normalizeWorkflowSpec({
      ...find(),
      find: { count: 500, top: 20, keep: 500, items: ['  A  ', 'a', '', 'B'] }
    })
    expect(read.find).toEqual({ count: 160, top: 8, keep: 100, items: ['A', 'B'] })
    const empty = normalizeWorkflowSpec({ ...find(), find: { count: 50, top: 5, items: [] } })
    expect(empty.find?.items).toEqual([])
    expect(
      validateWorkflowSpec(empty, { available: ROUTES }).problems.map((problem) => problem.message)
    ).toContain('Give at least two options to choose from, one per line.')
    expect(validateWorkflowSpec(find(), { available: ROUTES }).problems).toEqual([])
  })
})
