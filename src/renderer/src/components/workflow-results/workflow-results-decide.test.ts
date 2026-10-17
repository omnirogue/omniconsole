import { describe, expect, it } from 'vitest'
import type {
  LocalWorkflowCallView,
  LocalWorkflowGraphRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { workflowView } from '../local-workflows/local-workflow-ui.fixtures'
import { workflowResults } from './workflow-results-candidates'
import { workflowResultsSessionPrompt } from './workflow-results-session-prompt'
import { workflowResultsStarters } from './workflow-results-starters'

const base = workflowView().calls[0]!
const call = (id: string, resultMarkdown: string): LocalWorkflowCallView => ({
  ...base,
  id,
  state: 'completed',
  resultMarkdown
})
const round = (change: Partial<LocalWorkflowGraphRun['steps'][number]['rounds'][number]>) => ({
  round: 1,
  state: 'done' as const,
  calls: [],
  notes: [],
  ...change
})

type Check = NonNullable<LocalWorkflowGraphRun['steps'][number]['rounds'][number]['finalCheck']>
const CHECKED: Check = {
  result: 'chair',
  judgedBy: ['jev'],
  subject: 'decide',
  skeptic: { shipped: 'memo', status: 'kept', against: 'limits' }
}

function decideView(
  route?: LocalWorkflowGraphRun['route'],
  finalCheck: Check | null = CHECKED,
  gaps: string[] = []
): LocalWorkflowView {
  const standing = (name: string, place: number) => ({
    label: `Response ${'AB'[place - 1]}`,
    name,
    averageRank: place,
    votes: 3,
    place
  })
  return {
    ...workflowView(),
    executionId: 'run-1',
    state: 'completed',
    result: { markdown: 'Pick Postgres.\n\nGuard: …', sources: [], coverage: [] },
    calls: [
      call('develop/options.r1.2/a0', 'How Mongo works'),
      call('develop/options.r1.1/a0', 'How Postgres works')
    ],
    graphRun: {
      spec: workflowTemplate('decide', ['claude', 'codex', 'grok']),
      levels: {},
      gaps,
      notes: [],
      ...(route ? { route } : {}),
      steps: [
        {
          id: 'memo',
          state: 'done',
          agents: [],
          rounds: [round(finalCheck ? { finalCheck } : {})]
        },
        {
          id: 'develop',
          state: 'done',
          agents: [],
          rounds: [
            round({
              labels: [
                { callId: 'develop/options.r1.2/a0', label: 'Mongo atlas · Response A' },
                { callId: 'develop/options.r1.1/a0', label: 'Postgres managed · Response A' }
              ]
            })
          ]
        },
        {
          id: 'compare',
          state: 'done',
          agents: [],
          rounds: [
            round({
              standings: [standing('Postgres managed', 1), standing('Mongo atlas', 2)],
              criteria: [
                { criterion: 'Is it reliable?', leaders: ['Postgres managed'], judgedBy: ['jev'] },
                { criterion: 'Is it cheap?', leaders: ['Mongo atlas'], judgedBy: ['models'] }
              ]
            })
          ]
        }
      ]
    }
  }
}

describe('Decide results', () => {
  it('offers the shipped decision ticked, then the finalists in overall order', () => {
    const results = workflowResults(decideView())!
    expect(results.kind).toBe('decide')
    expect(results.candidates.map((entry) => [entry.title, entry.place, entry.leads])).toEqual([
      ['The recommendation (checked)', undefined, undefined],
      ['Postgres managed', 1, ['Is it reliable?']],
      ['Mongo atlas', 2, ['Is it cheap?']]
    ])
    expect(results.candidates[0]).toMatchObject({
      detail: 'Pick Postgres.\n\nGuard: …',
      decision: 'checked',
      winner: true,
      preselected: true
    })
    expect(results.candidates.slice(1).every((entry) => !entry.preselected)).toBe(true)
  })

  it.each([
    [
      'inconclusive',
      { ...CHECKED, result: 'inconclusive' },
      'The recommendation (the guard was not decisive)'
    ],
    [
      'unchecked',
      { ...CHECKED, skeptic: { shipped: 'memo', status: 'unchecked', why: 'failed' } },
      'The recommendation (not fully checked)'
    ],
    ['unchecked', { ...CHECKED, result: 'failed' }, 'The recommendation (not fully checked)'],
    ['unchecked', null, 'The recommendation (not fully checked)'],
    [
      'withheld',
      { ...CHECKED, skeptic: { shipped: 'none', status: 'withheld', finalistRejected: true } },
      'No recommendation passed the checks'
    ]
  ] as const)('never calls a %s decision the winner', (status, check, title) => {
    const decision = workflowResults(decideView(undefined, check as Check | null))!.candidates[0]!
    expect(decision).toMatchObject({ decision: status, title })
    expect(decision.winner).toBeUndefined()
  })

  it("names a one-answer run as one model's, and offers nothing without a result", () => {
    const routed = decideView({ route: 'one-answer', reason: 'one-answer', noul: 0.9 }, null)
    expect(workflowResults(routed)!.candidates[0]).toMatchObject({
      title: "One model's answer",
      decision: 'answer'
    })
    expect(workflowResults({ ...decideView(), result: undefined })).toBeUndefined()
  })

  it('starts a withheld decision with investigating, never acting, and checks others first', () => {
    const labels = (status: Parameters<typeof workflowResultsStarters>[1]) =>
      workflowResultsStarters('decide', status).map((starter) => starter.id)
    expect(labels('withheld')).toEqual(['investigate', 'compliant'])
    expect(workflowResultsStarters('decide', 'withheld')[0]!.instruction).toContain(
      'Do not act on any option'
    )
    for (const status of ['unchecked', 'inconclusive', 'warnings'] as const) {
      expect(labels(status)[0]).toBe('verify')
    }
    expect(labels('answer')[0]).toBe('act')
  })

  it('never claims more than the final checks: an earlier gap makes it "with warnings"', () => {
    const gap = 'Develop: JEV could not screen the options (JEV is turned off).'
    const decision = workflowResults(decideView(undefined, CHECKED, [gap]))!.candidates[0]!
    expect(decision).toMatchObject({
      decision: 'warnings',
      title: 'The recommendation (checked, with warnings)'
    })
    expect(decision.winner).toBeUndefined()
  })

  it("carries the run's warnings apart from the results, so no cut drops them", () => {
    const gap = 'The skeptic could not check what is shown against the hard limits.'
    const view = decideView(
      undefined,
      { ...CHECKED, skeptic: { shipped: 'memo', status: 'unchecked', why: 'failed' } },
      [gap]
    )
    const results = workflowResults(view)!
    expect(results.warnings).toEqual([gap])
    const long = { ...results.candidates[0]!, detail: 'x'.repeat(70_000) }
    const prompt = workflowResultsSessionPrompt({
      view,
      results,
      chosen: [long],
      instruction: '',
      worktreePath: '/work'
    })
    expect(prompt).toContain(
      `Warnings that run reported (read these first; they are never cut):\n- ${gap}`
    )
    expect(prompt).toContain('the recommendation, NOT fully checked (see the warnings)')
    expect(prompt).toContain('… (cut)')
  })

  it('starts a session from the decision with plain starters', () => {
    const view = decideView()
    const results = workflowResults(view)!
    expect(workflowResultsStarters('decide', 'checked').map((starter) => starter.label)).toEqual([
      'Act on it',
      'Run the next test',
      'Challenge it'
    ])
    const prompt = workflowResultsSessionPrompt({
      view,
      results,
      chosen: results.candidates.slice(0, 2),
      instruction: 'Go.',
      worktreePath: '/work'
    })
    expect(prompt).toContain('The decision from a Decide run in this workspace (execution run-1)')
    expect(prompt).toContain('led on: Is it reliable?')
    expect(prompt.endsWith('Instruction:\nGo.')).toBe(true)
  })
})
