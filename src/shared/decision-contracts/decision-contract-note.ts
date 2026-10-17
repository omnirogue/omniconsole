import type { DecisionContractCheck } from './decision-contract-check'
import type { UnknownOutcome } from './decision-contract-types'

type Translate = (key: string, fallback: string, options?: Record<string, unknown>) => string
const english: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))

/** What happens when JEV is unsure, as the clause that follows "then" or "when it is unsure,". */
export function unknownFallbackNote(
  fallback: UnknownOutcome,
  translate: Translate = english
): string {
  switch (fallback) {
    case 'models-decide':
      return translate('workflowGraph.judgeCheck.fallback.modelsDecide', 'the model judges decide')
    case 'keep-and-verify':
      return translate('workflowGraph.judgeCheck.fallback.keepAndVerify', 'a reviewer checks it')
    case 'full-workflow':
      return translate('workflowGraph.judgeCheck.fallback.fullWorkflow', 'the full Decide runs')
    case 'keep-incumbent':
      return translate(
        'workflowGraph.judgeCheck.fallback.keepIncumbent',
        'the best version so far stays'
      )
    case 'keep-chair':
      return translate(
        'workflowGraph.judgeCheck.fallback.keepChair',
        "the chairman's answer is kept"
      )
    case 'gap':
      return translate('workflowGraph.judgeCheck.fallback.gap', 'it is listed as a gap')
  }
}

/** One plain sentence on how far a decision's rule has been checked against known answers. */
export function decisionContractNote(
  check: Pick<DecisionContractCheck, 'state' | 'count' | 'agree' | 'unsure' | 'fallback'>,
  translate: Translate = english
): string {
  const fallback = unknownFallbackNote(check.fallback, translate)
  const count = check.count ?? 0
  switch (check.state) {
    case 'checked':
      return translate(
        'workflowGraph.judgeCheck.checked',
        'Checked against {{count}} questions with known answers. When JEV was sure, it agreed {{agree}}% of the time. It was unsure {{unsure}}% of the time; then {{fallback}}.',
        { count, agree: check.agree ?? 0, unsure: check.unsure ?? 0, fallback }
      )
    case 'too-few':
      return translate(
        'workflowGraph.judgeCheck.tooFew',
        'Checked against only {{count}} known answers so far: too few to rely on.',
        { count }
      )
    case 'failing':
      return translate(
        'workflowGraph.judgeCheck.failing',
        'Checked against {{count}} known answers, and JEV was wrong too often when sure, so treat its judgement here as a first opinion.',
        { count }
      )
    case 'not-yet':
      return translate(
        'workflowGraph.judgeCheck.notYet',
        "Not yet checked against known answers. Treat JEV's judgement here as a first opinion; when it is unsure, {{fallback}}.",
        { fallback }
      )
    case 'stale':
      return translate(
        'workflowGraph.judgeCheck.stale',
        'How JEV judges this has changed since it was last checked, so that check no longer counts.'
      )
  }
}
