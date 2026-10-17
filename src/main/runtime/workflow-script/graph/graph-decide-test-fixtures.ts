import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { decideWorkflow } from '../../../../shared/workflow-graph-decide'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { DECIDE_SKEPTIC_ROUND } from '../../../../shared/workflow-decide-guard'
import type { GraphCall } from './graph-plan-types'
import { text } from './graph-test-harness'

export const DECIDE_ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']
export const decideSpec = (oneAnswer = false): WorkflowSpec =>
  normalizeWorkflowSpec(decideWorkflow(DECIDE_ROUTES, { oneAnswer }), DECIDE_ROUTES)

export const FRAME = [
  '## Decision',
  'Pick a database.',
  '## Hard limits',
  '- Under $500 a month',
  '- Runs in the EU.',
  '## Rubric',
  '- Is it reliable?',
  '- Is it cheap to run?',
  '- Is it easy to operate?',
  '## What would change the answer',
  'Traffic doubling.'
].join('\n')

const NAMES = [
  ['Postgres managed', 'MySQL cluster', 'SQLite replicas', 'Cockroach serverless', 'Mongo atlas'],
  ['Dynamo tables', 'Firestore native', 'Redis durable', 'Cassandra ring', 'Spanner regional']
]

const options = (call: GraphCall) => ({
  items: NAMES[call.agentIndex]!.map((title, index) => ({
    title,
    detail: `A specific option numbered ${index} from agent ${call.agentIndex}.`,
    location: '',
    severity: 'none'
  }))
})

/** JEV scores keyed by the pool's item keys: the first option breaks a hard limit. */
export function screened(call: GraphCall) {
  const ids = call.screen!.candidates.map((candidate) => candidate.id)
  const score = (index: number, base: number) => Math.max(0, Math.min(4, base - index * 0.3))
  const line = (value: (index: number) => number) =>
    Object.fromEntries(ids.map((id, index) => [id, value(index)]))
  return {
    markdown: 'screened',
    scores: line((index) => score(index, 3.9)),
    criteria: [
      { id: 'c1', label: 'limits', scores: line((index) => (index ? 4 : 0)) },
      { id: 'c2', label: 'region', scores: line(() => 4) },
      { id: 'c3', label: 'reliable', scores: line((index) => score(index, 3)) },
      { id: 'c4', label: 'cheap', scores: line((index) => (index === 7 ? 4 : 1)) },
      { id: 'c5', label: 'easy', scores: line((index) => (index === 9 ? 4 : 1)) }
    ],
    unscored: []
  }
}

export const ballot = (order: string) =>
  text(`FINAL RANKING:\n${[...order].map((label, i) => `${i + 1}. Response ${label}`).join('\n')}`)

/** The guard's ballot: the memo first (JEV names its candidates; a model reads its prompt). */
export function memoFirst(call: GraphCall) {
  const labels = (call.jev?.candidates ?? []).map((candidate) => candidate.label.slice(-1))
  const memo = call.jev?.candidates.find((candidate) => candidate.markdown.startsWith('memo'))
  const first = memo?.label.slice(-1) ?? 'A'
  return ballot([first, ...labels.filter((label) => label !== first)].join('') || 'AB')
}

export type DecideAnswers = {
  compare?: (call: GraphCall) => unknown
  screen?: (call: GraphCall) => unknown
  guard?: (call: GraphCall) => unknown
  skeptic?: (call: GraphCall) => unknown
  frame?: string
}

/** Every Decide call answered: the comparison's lines (rounds 3+), its guard (2) and skeptics. */
export function decideAnswer(
  compare: (call: GraphCall) => unknown = () => ballot('ABCD'),
  screen: (call: GraphCall) => unknown = screened,
  more: Omit<DecideAnswers, 'compare' | 'screen'> = {}
) {
  const guard = more.guard ?? memoFirst
  const skeptic = more.skeptic ?? (() => text('It keeps every limit.\nVERDICT: PASS'))
  return (call: GraphCall): unknown =>
    call.screen
      ? screen(call)
      : call.stepId === 'frame'
        ? text(more.frame ?? FRAME)
        : call.stepId === 'options'
          ? options(call)
          : call.stepId === 'compare'
            ? call.round === 2
              ? guard(call)
              : call.round >= DECIDE_SKEPTIC_ROUND
                ? skeptic(call)
                : compare(call)
            : text(`${call.stepId} answer from ${call.id}`)
}
