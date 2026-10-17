import type { WorkflowSpec, WorkflowStep } from './workflow-graph'

/**
 * One-answer routing: before any step runs, JEV answers one yes/no (NOUL) question about the
 * person's question. Only a sure yes sends it to one model; an unsure reading, a no, or no reading
 * at all runs the whole workflow, so routing never fails open to a single model.
 */
export { ONE_ANSWER_QUESTION } from './jev-confidence'

/** Inside this band, both ends included, JEV is unsure and the question goes to the full workflow. */
export const ONE_ANSWER_UNSURE_BAND = [0.35, 0.65] as const

export const ONE_ANSWER_INSTRUCTION =
  'This question has one right answer. Give it directly and completely, show how you know it (the calculation, the source or the reasoning), and say plainly if anything about it is uncertain.'

export type WorkflowOneAnswerRoute = {
  route: 'one-answer' | 'full'
  /** Why: JEV was sure of one answer, sure there is not one, unsure, or could not answer. */
  reason: 'one-answer' | 'open' | 'unsure' | 'unavailable'
  /** JEV's probability that the question has one right answer, when it gave one. */
  noul?: number
  /** Why JEV could not answer, when it could not. */
  detail?: string
}

type Translate = (key: string, fallback: string, values?: Record<string, string>) => string
const english: Translate = (_key, fallback, values = {}) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')

/** The route JEV's reading decides; a missing or broken reading runs the full workflow. */
export function decideOneAnswerRoute(
  reading: { noul: number } | { failed: string },
  band: readonly [number, number] = ONE_ANSWER_UNSURE_BAND
): WorkflowOneAnswerRoute {
  if ('failed' in reading || !Number.isFinite(reading.noul)) {
    return {
      route: 'full',
      reason: 'unavailable',
      detail: 'failed' in reading ? reading.failed : 'JEV gave no probability'
    }
  }
  const { noul } = reading
  const [low, high] = band
  return noul > high
    ? { route: 'one-answer', reason: 'one-answer', noul }
    : { route: 'full', reason: noul < low ? 'open' : 'unsure', noul }
}

/** The route as a saved or compiled spec carries it, with the step's id mapped like the rest. */
export function normalizeOneAnswer(
  raw: unknown,
  mapId: (value: unknown) => string | undefined
): Pick<WorkflowSpec, 'oneAnswer'> {
  const step = raw && typeof raw === 'object' ? (raw as { step?: unknown }).step : undefined
  return typeof step === 'string' ? { oneAnswer: { step: mapId(step)! } } : {}
}

/** The step that answers alone, when the spec routes and that step can stand alone. */
export function oneAnswerStep(spec: WorkflowSpec): WorkflowStep | undefined {
  const step = spec.steps.find((entry) => entry.id === spec.oneAnswer?.step)
  // Find the best picks its own steps by kind, so it could mistake this one for its options.
  return step &&
    !spec.find &&
    step.kind === 'do' &&
    step.agents.length === 1 &&
    !step.inputs.length &&
    !step.forEach &&
    !step.list &&
    spec.repeat?.do !== step.id &&
    !spec.steps.some((entry) => entry.inputs.includes(step.id))
    ? step
    : undefined
}

/** The problems a routed spec has; empty when it routes correctly or does not route. */
export function oneAnswerProblems(spec: WorkflowSpec, translate: Translate = english): string[] {
  if (!spec.oneAnswer) {
    return []
  }
  if (!oneAnswerStep(spec)) {
    return [
      translate(
        'workflowGraph.oneAnswer.invalid',
        'One-answer routing needs a Do step with one agent that takes no input and that no other step reads, outside Find the best.'
      )
    ]
  }
  return spec.steps.length < 2
    ? [
        translate(
          'workflowGraph.oneAnswer.alone',
          'One-answer routing needs the rest of the workflow to fall back to.'
        )
      ]
    : []
}

const percent = (noul: number | undefined) =>
  noul === undefined ? '' : `${Math.round(noul * 100)}%`

/** What the run says about its route, in the results and in its notes. */
export function oneAnswerNote(
  decision: WorkflowOneAnswerRoute,
  translate: Translate = english
): string {
  const values = { chance: percent(decision.noul), detail: decision.detail ?? '' }
  switch (decision.reason) {
    case 'one-answer':
      return translate(
        'workflowGraph.oneAnswer.routed',
        'JEV judged that this question has one right answer ({{chance}} sure), so one model answered it and the run ended there.',
        values
      )
    case 'open':
      return translate(
        'workflowGraph.oneAnswer.open',
        'JEV judged that this question needs judgement, not one right answer ({{chance}} that it has one), so the full workflow ran.',
        values
      )
    case 'unsure':
      return translate(
        'workflowGraph.oneAnswer.unsure',
        'JEV was not sure whether this question has one right answer ({{chance}}), so the full workflow ran.',
        values
      )
    case 'unavailable':
      return translate(
        'workflowGraph.oneAnswer.unavailable',
        'JEV could not say whether this question has one right answer ({{detail}}), so the full workflow ran.',
        values
      )
  }
}

/** The line the setup reads back before Start. */
export function oneAnswerDescription(translate: Translate = english): string {
  return translate(
    'workflowGraph.oneAnswer.description',
    'First, JEV checks whether the question has one right answer. Only if it is sure does one model answer it alone and the run end there; otherwise, or if JEV cannot tell, the full workflow runs.'
  )
}

/** Why a step did not run because of the route. */
export function oneAnswerSkipped(routed: boolean, translate: Translate = english): string {
  return routed
    ? translate(
        'workflowGraph.oneAnswer.skippedFull',
        'Not run: the question has one right answer, so one model answered it.'
      )
    : translate(
        'workflowGraph.oneAnswer.skippedAnswer',
        'Not run: the question went to the full workflow.'
      )
}
