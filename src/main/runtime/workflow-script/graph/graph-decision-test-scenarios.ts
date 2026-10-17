import { createHash } from 'node:crypto'
import {
  localWorkflowFindRequestSchema,
  localWorkflowFindSpec
} from '../../../../shared/local-workflow-find-request'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { screenedDiscover } from '../../../../shared/workflow-discover-screen.test-fixture'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { decideAnswer, decideSpec, screened } from './graph-decide-test-fixtures'
import type { GraphCall, GraphPlan } from './graph-plan-types'
import { text } from './graph-test-harness'

const ROUTES = ['claude', 'codex', 'grok'] as const

/** One run of a template through every JEV decision it makes, answered the same way each time. */
export type DecisionScenario = {
  name: string
  spec: WorkflowSpec
  answer: (call: GraphCall) => unknown
}

// The labels a judge is shown: JEV's from its request, a model's from its prompt.
const labelsOf = (call: GraphCall) =>
  call.jev
    ? call.jev.candidates.map((candidate) => candidate.label)
    : [...new Set(call.prompt.match(/Response [A-Z]\b/g) ?? [])]

const ranking = (labels: readonly string[]) =>
  text(`FINAL RANKING:\n${labels.map((label, place) => `${place + 1}. ${label}`).join('\n')}`)

/** Last shown first: every judge disagrees with the order it was shown. */
const reversed = (call: GraphCall) => ranking(labelsOf(call).toReversed())

/** Scores by position, the second option left unscored; the first scores below every line. */
function screenOf(call: GraphCall, criteria: string[] = []) {
  const ids = call.screen!.candidates.map((candidate) => candidate.id)
  const score = (index: number) => (index === 0 ? 0.5 : Math.max(1, 3.9 - index * 0.2))
  const scored = ids.filter((_, index) => index !== 1)
  const line = (value: (index: number) => number) =>
    Object.fromEntries(scored.map((id) => [id, value(ids.indexOf(id))]))
  return {
    markdown: 'screened',
    scores: line(score),
    criteria: criteria.map((label, at) => ({
      id: `c${at + 1}`,
      label,
      scores: line((index) => (index === ids.length - 1 - at ? 4 : 1))
    })),
    unscored: [ids[1]]
  }
}

const council: DecisionScenario = {
  name: 'Council',
  spec: workflowTemplate('council', ROUTES),
  answer: (call) => {
    if (call.stepId === 'answer') {
      return text(`Opinion ${call.agentIndex}: keep it short.`)
    }
    if (call.stepId === 'chair') {
      return text('Chair answer')
    }
    if (call.jev && call.round === 2) {
      // The final check: JEV sure the first opinion is better.
      const first = call.jev.candidates.find((entry) => entry.markdown.startsWith('Opinion'))
      return ranking([first!.label, ...labelsOf(call).filter((label) => label !== first!.label)])
    }
    return call.jev ? { ...reversed(call), unsure: true } : reversed(call)
  }
}

const finding = (title: string, severity: string, line: number) => ({
  title,
  detail: `A concrete failure scenario for ${title}.`,
  location: `src/${title.toLowerCase().replace(/\W+/g, '-')}.ts:${line}`,
  severity,
  excerpt: `const ${title.replace(/\W+/g, '')} = 1`,
  trigger: 'On every save.'
})

const discover: DecisionScenario = {
  name: 'Discover',
  // The screen left the default template on 2026-09-27; its set-aside gate is still exercised.
  spec: screenedDiscover(ROUTES),
  answer: (call) => {
    if (call.screen) {
      return screenOf(call)
    }
    if (call.evidence) {
      const statuses = ['found', 'missing', 'moved'] as const
      return {
        checks: Object.fromEntries(
          call.evidence.items.map((item, index) => [
            item.key,
            { status: statuses[index % 3], line: item.line }
          ])
        )
      }
    }
    if (call.stepId === 'brief') {
      return text('## Goal\nFind bugs.\n## Rubric\n- Is it specific?\n- Is it real?')
    }
    if (call.stepId === 'scout') {
      return {
        items: ['Cache', 'Queue'].map((title) => ({
          title,
          detail: `The ${title}.`,
          location: `src/${title.toLowerCase()}`,
          severity: 'none'
        }))
      }
    }
    if (call.stepId === 'find') {
      const area = call.itemKey ?? 'area'
      return {
        items: [
          finding(`${area} key ignores locale`, 'high', 10),
          finding(`${area} stale read`, 'medium', 20),
          finding(`${area} style nit`, 'low', 30)
        ]
      }
    }
    if (call.stepId === 'verify') {
      return text(`Traced it.\nVERDICT: ${call.agentIndex === 0 ? 'PASS' : 'FAIL'}`)
    }
    return text(`${call.stepId} answer`)
  }
}

const improve: DecisionScenario = {
  name: 'Improve',
  spec: workflowTemplate('improve', ROUTES),
  answer: (call) => {
    if (!call.jev && call.stepId !== 'judge') {
      return text(`Version ${call.round} by ${call.agentIndex}`)
    }
    // Round 2 JEV is sure the challenger is better; round 3 it is unsure; round 4 it fails.
    return call.round === 4 && call.jev
      ? undefined
      : call.round === 3 && call.jev
        ? { ...reversed(call), unsure: true }
        : reversed(call)
  }
}

const WORDS = ['Crumb', 'Hearth', 'Rye', 'Knead', 'Proof', 'Oven', 'Flour', 'Sift', 'Dough', 'Loaf']

const findOptions = (call: GraphCall) => ({
  items: Array.from({ length: 2 }, (_, index) => ({
    title: `${WORDS[call.agentIndex * 2 + index]} Bakery`,
    detail: `${WORDS[call.agentIndex * 2 + index]} names the craft plainly.`,
    location: '',
    severity: 'none'
  }))
})

const find: DecisionScenario = {
  name: 'Find the best',
  spec: workflowTemplate('find', ROUTES),
  answer: (call) => (call.screen ? screenOf(call) : call.jev ? reversed(call) : findOptions(call))
}

const findByLine: DecisionScenario = {
  name: 'Find the best, your list and rubric lines',
  spec: localWorkflowFindSpec(
    localWorkflowFindRequestSchema.parse({
      prompt: 'Choose',
      items: Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`),
      top: 3,
      good: '- Low cost\n- High quality'
    }),
    ROUTES,
    []
  ),
  answer: (call) =>
    call.screen
      ? screenOf(call, ['Low cost', 'High quality'])
      : call.jev
        ? { ...reversed(call), unsure: true }
        : reversed(call)
}

/** Decide's screen with one option JEV could not score: it is kept and developed first. */
function unscoredOption(call: GraphCall) {
  const screen = screened(call)
  const second = call.screen!.candidates[1]!.id
  const drop = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => id !== second))
  return {
    ...screen,
    scores: drop(screen.scores),
    criteria: screen.criteria.map((line) => ({ ...line, scores: drop(line.scores) })),
    unscored: [second]
  }
}

const routeAnswer =
  (noul: number) =>
  (call: GraphCall): unknown =>
    call.route ? { markdown: 'route', noul } : decideAnswer()(call)

/** Every template with a JEV decision, each decision type met at least once. */
export const DECISION_SCENARIOS: DecisionScenario[] = [
  council,
  discover,
  { name: 'Decide', spec: decideSpec(), answer: decideAnswer() },
  {
    name: 'Decide, an option unscored',
    spec: decideSpec(),
    answer: decideAnswer(undefined, unscoredOption)
  },
  { name: 'Decide, one answer unsure', spec: decideSpec(true), answer: routeAnswer(0.5) },
  { name: 'Decide, one answer sure', spec: decideSpec(true), answer: routeAnswer(0.9) },
  find,
  findByLine,
  improve
]

/** The whole plan: every call's id, prompt and host request, every step's runs, the outcome. */
export const planDigest = (plan: GraphPlan): string =>
  createHash('sha256').update(JSON.stringify(plan)).digest('hex')
