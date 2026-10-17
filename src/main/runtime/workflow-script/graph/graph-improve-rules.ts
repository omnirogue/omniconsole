import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowCheckHasPractice } from '../../../../shared/workflow-improve-host-calls'
import type { GraphConfig } from './graph-plan-types'

/**
 * Rules 2: practice cases, a time limit, SCORE on the last line, and measured stopping. Rules 3:
 * improvers are also told the best version's weakest criteria and what earlier rounds tried that
 * lost (graph-improve-reflection.ts); a change to the code already checked is not tested or
 * judged again; and a challenger only its own family's judges preferred does not take the lead.
 */
export const IMPROVE_RULES = 3

/** Absent on older snapshots so their Improve calls and stopping points replay unchanged. */
export function graphImproveRules(
  snapshot: object
): Pick<GraphConfig, 'improveUnresolvedRounds' | 'improveRules'> {
  const host = (
    snapshot as { host?: { improveUnresolvedRounds?: unknown; improveRules?: unknown } }
  ).host
  return {
    ...(host?.improveUnresolvedRounds === true ? { improveUnresolvedRounds: true as const } : {}),
    ...(typeof host?.improveRules === 'number' ? { improveRules: host.improveRules } : {})
  }
}

/** Whether this run measures Improve by its check (rules 2 and a check): the old rules otherwise. */
export function graphImproveMeasured(config: Pick<GraphConfig, 'spec' | 'improveRules'>): boolean {
  return (config.improveRules ?? 0) >= 2 && !!config.spec.repeat?.check
}

/** Whether improvers are told what to fix first and what not to repeat (rules 3). */
export function graphImproveReflects(config: Pick<GraphConfig, 'improveRules'>): boolean {
  return (config.improveRules ?? 0) >= 3
}

/** Whether each version is a change to the code, tested in a private copy (rules 2 only). */
export function graphImproveChangesCode(
  config: Pick<GraphConfig, 'spec' | 'improveRules'>
): boolean {
  return graphImproveMeasured(config) && config.spec.repeat?.check?.apply === 'patch'
}

/**
 * Whether a change to the code that was already checked in this run (diff noise aside) reuses
 * that result instead of being tested again (rules 3). Not when the command names the version's
 * own text ({candidate}, {code}): two versions with one change still differ there.
 */
export function graphImproveSkipsRepeatedChanges(
  config: Pick<GraphConfig, 'spec' | 'improveRules'>
): boolean {
  const command = config.spec.repeat?.check?.command ?? ''
  return (
    (config.improveRules ?? 0) >= 3 &&
    graphImproveChangesCode(config) &&
    !/\{(?:candidate|code)\}/.test(command)
  )
}

/** Whether a challenger needs a judge outside its own model family to take the lead (rules 3). */
export function graphImproveVerifiesAcrossFamilies(
  config: Pick<GraphConfig, 'improveRules'>
): boolean {
  return (config.improveRules ?? 0) >= 3
}

/** Whether a final test kept back runs once the search stops (rules 2 and the person's field). */
export function graphImproveFinalTest(config: Pick<GraphConfig, 'spec' | 'improveRules'>): boolean {
  return graphImproveMeasured(config) && !!config.spec.repeat?.check?.sealed
}

/** Whether each version must predict its test result first (rules 2, a check, the person's field). */
export function graphImprovePredicts(config: Pick<GraphConfig, 'spec' | 'improveRules'>): boolean {
  return graphImproveMeasured(config) && config.spec.repeat?.check?.predict === true
}

/** How many versions improvers build on: the person's number under rules 2, else only the best. */
export function graphImprovePopulation(config: Pick<GraphConfig, 'spec' | 'improveRules'>): number {
  const population = config.spec.repeat?.population ?? 1
  return (config.improveRules ?? 0) >= 2 && population > 1 ? population : 1
}

/**
 * Practice cases, a time limit or a change to the code exist only in runs admitted under rules 2.
 * A snapshot from older rules that carries them was never admitted by a released build, so it is
 * refused rather than replayed differently or silently upgraded; so is a change to the code
 * without the commit its private copies start from.
 */
export function assertImproveReplaySupported(spec: WorkflowSpec, snapshot: object): void {
  const rules = graphImproveRules(snapshot).improveRules ?? 0
  if (
    spec.repeat?.until === 'plateau' &&
    workflowCheckHasPractice(spec.repeat.check) &&
    rules < 2
  ) {
    throw new Error(
      "This Improve run's practice cases were saved by a build that can't replay them; start it again."
    )
  }
  if (spec.repeat?.until === 'plateau' && (spec.repeat.population ?? 1) > 1 && rules < 2) {
    throw new Error(
      "This Improve run's versions to build on were saved by a build that can't replay them; start it again."
    )
  }
  const host = (snapshot as { host?: { checkSource?: { sourceBase?: unknown } } }).host
  if (spec.repeat?.check?.apply === 'patch' && typeof host?.checkSource?.sourceBase !== 'string') {
    throw new Error(
      "This Improve run's changes to your code have no saved commit to test them on; start it again."
    )
  }
}
