import type { WorkflowCheck, WorkflowSpec } from './workflow-graph'

/**
 * Practice cases, a time limit, predictions or a change to the code: fields only Improve rules 2 plans and
 * runs. A run admitted under older rules never carries them.
 */
export function workflowCheckHasPractice(check: WorkflowCheck | undefined): boolean {
  return (
    !!check &&
    (!!check.cases?.length ||
      check.timeoutSeconds !== undefined ||
      check.apply === 'patch' ||
      check.predict === true ||
      // A final test kept back, too.
      !!check.sealed)
  )
}

/**
 * Improve's version checks, one host call per version at most, and one more for "No change"
 * when versions are changes to the code. Counted only for a check with rules-2 fields, so a run
 * admitted before them keeps the call bound it was admitted under.
 */
export function workflowImproveHostCalls(spec: WorkflowSpec): number {
  const repeat = spec.repeat
  if (repeat?.until !== 'plateau' || !workflowCheckHasPractice(repeat.check)) {
    return 0
  }
  const step = spec.steps.find((entry) => entry.id === repeat.do)
  const unchanged = repeat.check?.apply === 'patch' ? 1 : 0
  // The final test kept back: the winner, and what the search started from.
  const final = repeat.check?.sealed ? 2 : 0
  return repeat.maxRounds * (step?.agents.length ?? 0) + unchanged + final
}
