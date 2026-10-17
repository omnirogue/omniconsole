// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { WorkflowGraphRunView } from './WorkflowGraphRunView'
import { WorkflowCouncilFinalCheck } from './WorkflowCouncilFinalCheck'
import type { CouncilFinalCheck } from '../../../../shared/workflow-council-final-check'

const { compile } = vi.hoisted(() => ({ compile: vi.fn() }))
vi.mock('./use-workflow-compile', () => ({
  useWorkflowCompile: () => ({ compile, compiling: false, cancel: vi.fn() })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, string | number>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values?.[key] ?? ''))
}))
vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span data-agent-icon={agent} />
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const ROUTES = ['claude', 'codex', 'grok'] as const
const seat = (agent: 'claude' | 'codex' | 'grok', modelLabel: string) => ({
  seatId: agent,
  agent,
  model: modelLabel,
  modelLabel,
  effort: null
})

function discoverView(): LocalWorkflowView {
  const spec = workflowTemplate('discover', ROUTES, { depth: 'quick' })
  const call = (id: string, state: 'completed' | 'running', markdown?: string) => ({
    id,
    stageId: id.split('/')[0],
    agent: 'claude' as const,
    seatLabel: 'Claude',
    modelLabel: 'Claude Opus 5',
    model: 'claude-opus-5',
    effort: null,
    state,
    attempt: 1,
    attemptLimit: 3,
    transport: 'headless' as const,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    ...(markdown ? { resultMarkdown: markdown } : {})
  })
  return {
    executionId: 'execution-1',
    fence: 1,
    sequence: 4,
    preset: 'discover',
    state: 'running',
    connection: 'connected',
    prompt: 'Find real bugs in checkout',
    startedAt: 1,
    running: 1,
    queued: 0,
    reused: 0,
    actions: ['pause', 'stop'],
    stages: [],
    calls: [
      call('verify/scout.r1.1/find.r1.1/a0', 'completed', 'Real.\nVERDICT: PASS'),
      call('verify/scout.r1.1/find.r1.1/a1', 'running')
    ],
    graphRun: {
      spec,
      levels: { scout: 0, find: 1, verify: 2, report: 3 },
      steps: [
        {
          id: 'scout',
          state: 'done',
          agents: [seat('claude', 'Claude Opus 5')],
          rounds: [{ round: 1, state: 'done', calls: [], notes: [] }]
        },
        {
          id: 'find',
          state: 'gaps',
          reason: '1 agent call of 3 did not return a result.',
          agents: [],
          rounds: [{ round: 1, state: 'gaps', calls: [], notes: [] }]
        },
        {
          id: 'verify',
          state: 'running',
          agents: [
            seat('codex', 'GPT-5.6 Sol'),
            seat('grok', 'Grok 4.6'),
            seat('claude', 'Claude Opus 5')
          ],
          rounds: [
            {
              round: 1,
              state: 'running',
              calls: [
                {
                  callId: 'verify/scout.r1.1/find.r1.1/a0',
                  agentIndex: 0,
                  itemKey: 'find.r1.1',
                  status: 'done',
                  verdict: 'pass'
                },
                {
                  callId: 'verify/scout.r1.1/find.r1.1/a1',
                  agentIndex: 1,
                  itemKey: 'find.r1.1',
                  status: 'waiting'
                }
              ],
              targets: [
                {
                  key: 'find.r1.1',
                  title: 'Refund applied twice',
                  detail: 'A retry after a timeout refunds again.',
                  location: 'src/checkout/refund.ts:88',
                  severity: 'high',
                  repeats: 1,
                  alsoReported: [
                    {
                      title: 'Refund retried without an idempotency key',
                      detail: 'The retry path builds a new request id.',
                      location: 'src/checkout/refund.ts:91',
                      severity: 'high'
                    }
                  ],
                  jev: { score: 3.6 },
                  tally: 'unverified',
                  votes: ['pass', null, null]
                },
                {
                  key: 'find.r1.2',
                  title: 'Coupon stacks with itself',
                  detail: 'Applying the same code twice doubles the discount.',
                  location: 'src/checkout/coupon.ts:12',
                  severity: 'low',
                  repeats: 0,
                  tally: 'unverified',
                  votes: [null, null, null],
                  unchecked: true
                },
                {
                  key: 'find.r1.3',
                  title: 'Variable names are short',
                  detail: 'Style only.',
                  location: '',
                  severity: 'none',
                  repeats: 0,
                  jev: { score: 0.3 },
                  tally: 'unverified',
                  votes: [null, null, null],
                  unchecked: true,
                  screened: true
                }
              ],
              notes: []
            }
          ]
        },
        {
          id: 'report',
          state: 'waiting',
          agents: [seat('claude', 'Claude Opus 5')],
          rounds: [{ round: 1, state: 'waiting', calls: [], notes: [] }]
        }
      ],
      gaps: [],
      notes: []
    }
  }
}

describe('workflow graph run view', () => {
  it('draws every step with its live state and follows the running step', () => {
    render(<WorkflowGraphRunView view={discoverView()} handlers={{}} />)
    const steps = screen.getByRole('group', { name: 'Workflow steps' })
    expect(within(steps).getByRole('button', { name: /Scout, Do, Done/ })).toBeVisible()
    expect(within(steps).getByRole('button', { name: /Find, Do, Done with gaps/ })).toBeVisible()
    expect(within(steps).getByRole('button', { name: /Verify, Review, Running/ })).toBeVisible()
    expect(within(steps).getByRole('button', { name: /Report, Synthesize, Waiting/ })).toBeVisible()
    // The running step is open: each finding with its tally and the votes so far.
    const verify = screen.getByRole('region', { name: 'Verify' })
    expect(within(verify).getByText('Refund applied twice')).toBeVisible()
    expect(within(verify).getAllByText('Unverified')).toHaveLength(3)
    expect(within(verify).getByText('JEV 3.6')).toBeVisible()
    fireEvent.click(within(verify).getByText('Refund applied twice'))
    expect(within(verify).getByRole('tab', { name: /GPT-5.6 Sol · Pass/ })).toBeVisible()
    expect(within(verify).getByText(/Real\./)).toBeVisible()
    // A report merged into this finding stays visible as it was written.
    expect(within(verify).getByText('Also reported as:')).toBeVisible()
    expect(within(verify).getByText('Refund retried without an idempotency key')).toBeVisible()
    // A finding over the limit is listed, and says no reviewer saw it.
    expect(within(verify).getByText('not checked: over the limit')).toBeVisible()
    // One JEV set aside says so, rather than blaming the limit.
    expect(within(verify).getByText('set aside by JEV as a non-finding')).toBeVisible()
  })

  it('names what did not go to plan once the run settles', () => {
    const view = discoverView()
    render(
      <WorkflowGraphRunView
        view={{
          ...view,
          state: 'completed',
          result: { markdown: 'The report.', sources: [], coverage: [] },
          graphRun: {
            ...view.graphRun!,
            gaps: ['Find: 1 agent call of 3 did not return a result.']
          }
        }}
        handlers={{}}
      />
    )
    expect(screen.getByRole('region', { name: 'What did not go to plan' })).toHaveTextContent(
      'Find: 1 agent call of 3 did not return a result.'
    )
    expect(screen.getByRole('region', { name: 'Report' })).toHaveTextContent('The report.')
  })
})

it.each([
  [['jev'], 'Decided by JEV.'],
  [['models'], 'Decided by model judges.'],
  [['jev', 'models'], 'Decided by JEV and model judges.']
] as const)('shows the shipped answer and %s as the decider', (judgedBy, decider) => {
  render(<WorkflowCouncilFinalCheck check={{ result: 'first-opinion', judgedBy: [...judgedBy] }} />)
  expect(
    screen.getByText(
      'Final check: the best first opinion was judged better, so it is shown instead.'
    )
  ).toBeVisible()
  expect(screen.getByText(decider)).toBeVisible()
})

describe('WorkflowCouncilFinalCheck: every state, and a non-decision never claims one', () => {
  const cases: {
    result: CouncilFinalCheck['result']
    judgedBy: CouncilFinalCheck['judgedBy']
    note: string
  }[] = [
    {
      result: 'chair',
      judgedBy: ['jev'],
      note: "Final check: the chairman's answer was compared blind with the best first opinion and kept."
    },
    {
      result: 'first-opinion',
      judgedBy: ['jev'],
      note: 'Final check: the best first opinion was judged better, so it is shown instead.'
    },
    {
      result: 'inconclusive',
      judgedBy: [],
      note: "Final check: the comparison was not decisive, so the chairman's answer was kept."
    },
    {
      result: 'failed',
      judgedBy: [],
      note: "The final check could not run, so the chairman's answer is shown unchecked."
    },
    {
      result: 'no-peer-votes',
      judgedBy: [],
      note: "The final check was skipped: Peer rankings counted no votes, so the chairman's answer is shown unchecked."
    },
    {
      result: 'finished-early',
      judgedBy: [],
      note: 'The final check was skipped: the run finished early.'
    }
  ]

  it.each(cases)('renders $result plainly, with no decider claim on a non-decision', (row) => {
    render(<WorkflowCouncilFinalCheck check={{ result: row.result, judgedBy: row.judgedBy }} />)
    expect(screen.getByText(row.note)).toBeVisible()
    if (row.judgedBy.length === 0) {
      expect(screen.queryByText('Decided by JEV.')).toBeNull()
      expect(screen.queryByText('Decided by model judges.')).toBeNull()
    }
    // A non-decision (chair kept without a strict win, or the check never ran/settled) must
    // never say the comparison went in the chairman's favour by a real judgement.
    if (row.result !== 'first-opinion') {
      expect(screen.queryByText(/judged better/i)).toBeNull()
    }
  })
})
