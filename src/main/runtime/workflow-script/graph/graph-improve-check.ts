import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import { graphPatchText, normalizedPatchKey } from './graph-check-patch'
import type { ImproveVersion } from './graph-improve-decide'
import { graphImproveMeasured } from './graph-improve-rules'
import {
  GRAPH_CHECK_SEAT_ID,
  type GraphCall,
  type GraphCheckRequest,
  type GraphCheckResult,
  type GraphConfig,
  type GraphOutcome
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/** `<the call that wrote the version>/check`: a version's check sits beside its author's call. */
export function graphCheckCallId(authorCallId: string): string {
  return `${authorCallId}/check`
}

/** A settled check call's result. A check that could not run did not pass. */
export function checkResult(outcome: GraphOutcome): GraphCheckResult {
  const value = 'value' in outcome ? (outcome.value as Partial<GraphCheckResult> | null) : null
  return value && typeof value.passed === 'boolean'
    ? {
        passed: value.passed,
        ...(typeof value.score === 'number' && Number.isFinite(value.score)
          ? { score: value.score }
          : {}),
        detail: typeof value.detail === 'string' ? value.detail : '',
        ...(value.unavailable === true ? { unavailable: true as const } : {}),
        ...caseCounts(value.cases),
        ...(Array.isArray(value.exits) &&
        value.exits.length &&
        value.exits.every((name) => typeof name === 'string')
          ? { exits: value.exits }
          : {})
      }
    : { passed: false, unavailable: true, detail: 'The check could not run.' }
}

function caseCounts(raw: unknown): Pick<GraphCheckResult, 'cases'> {
  const counts = raw as
    | Partial<Record<'total' | 'passed' | 'unavailable' | 'passing', unknown>>
    | undefined
  const count = (value: unknown) =>
    Number.isInteger(value) && (value as number) >= 0 ? (value as number) : -1
  const [total, passed, unavailable] = [counts?.total, counts?.passed, counts?.unavailable].map(
    count
  )
  if (!(total >= 0 && passed >= 0 && unavailable >= 0 && passed + unavailable <= total)) {
    return {}
  }
  // Results saved before the passing cases were named keep their counts and name none.
  const passing = Array.isArray(counts?.passing)
    ? counts.passing.filter(
        (index): index is number => Number.isInteger(index) && index >= 0 && index < total
      )
    : undefined
  return {
    cases: {
      total,
      passed,
      unavailable,
      ...(passing && passing.length === passed ? { passing } : {})
    }
  }
}

/**
 * What every version's check call asks. Under Improve rules 2: SCORE only on the last line, and
 * the practice cases, time limit and code-change settings when the person set them. Older runs
 * ask exactly as before.
 */
export function improveCheckRequest(
  config: Pick<GraphConfig, 'spec' | 'improveRules'>
): Omit<GraphCheckRequest, 'candidate'> {
  const check = config.spec.repeat!.check!
  if (!graphImproveMeasured(config)) {
    return { command: check.command }
  }
  return {
    command: check.command,
    scoreLastLine: true,
    ...(check.cases?.length ? { cases: check.cases } : {}),
    ...(check.timeoutSeconds !== undefined ? { timeoutSeconds: check.timeoutSeconds } : {}),
    ...(check.apply === 'patch'
      ? {
          apply: 'patch' as const,
          ...(check.prepare ? { prepare: check.prepare } : {}),
          ...(check.protect?.length ? { protect: check.protect } : {})
        }
      : {})
  }
}

/**
 * Plans the objective check of each new version (the best version was checked in the round that
 * made it) and reads back the ones that finished, onto the versions. True while any still runs.
 * With `checked` (rules 3), a change already checked this run, diff noise aside, is not tested
 * again: it takes that version's result and names it.
 */
export function planImproveChecks(
  scope: GraphScope,
  stepId: string,
  versions: readonly ImproveVersion[],
  request: Omit<GraphCheckRequest, 'candidate'>,
  checked?: Map<string, ImproveVersion>
): boolean {
  const { command, ...rules } = request
  let pending = false
  for (const version of versions) {
    const patch = checked ? graphPatchText(version.text.markdown) : undefined
    if (checked && patch) {
      const key = normalizedPatchKey(patch)
      const first = checked.get(key)
      version.patchKey = key
      if (first) {
        version.duplicateOf = { round: first.round, name: first.text.name }
        if (first.check) {
          version.check = first.check
        } else {
          pending = true
        }
        continue
      }
      checked.set(key, version)
    }
    const id = graphCheckCallId(version.text.callId)
    const call: GraphCall = {
      id,
      prompt: '',
      schema: textAnswerSchema,
      output: 'text',
      seatId: GRAPH_CHECK_SEAT_ID,
      dependencies: [version.text.callId],
      stepId,
      round: version.round,
      agentIndex: version.text.agentIndex,
      check: { command, candidate: version.text.markdown, ...rules },
      validateSemantics: () => null
    }
    scope.calls.push(call)
    const outcome = scope.outcomes.get(id)
    if (outcome) {
      version.check = checkResult(outcome)
    } else {
      pending = true
    }
  }
  return pending
}

/** How a check ranks a version: passing, then practice cases passed, then score. */
export function improveCheckMeasure(check: GraphCheckResult | undefined): number[] {
  return [
    check?.passed ? 1 : 0,
    check?.cases?.passed ?? 0,
    check?.score ?? Number.NEGATIVE_INFINITY
  ]
}

/** Above zero when `left` measures better than `right`, zero when the check cannot tell. */
export function compareImproveMeasure(left: number[], right: number[]): number {
  const at = left.findIndex((value, index) => value !== right[index])
  return at === -1 ? 0 : left[at]! > right[at]! ? 1 : -1
}

/**
 * The versions the check cannot tell apart: passing beats failing, more practice cases passed
 * beat fewer, then a higher score beats a lower one. One version left means the check decided;
 * several go on to the judges.
 */
export function checkContenders(lineup: readonly ImproveVersion[]): ImproveVersion[] {
  const best = lineup
    .map((version) => improveCheckMeasure(version.check))
    .reduce((top, next) => (compareImproveMeasure(next, top) > 0 ? next : top))
  return lineup.filter(
    (version) => compareImproveMeasure(improveCheckMeasure(version.check), best) === 0
  )
}
