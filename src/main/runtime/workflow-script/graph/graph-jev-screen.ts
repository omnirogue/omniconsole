import { createHash } from 'node:crypto'
import { jevScreen, type JevScreen } from '../../../structured-decisions/jev-rank'
import type { GraphJevOptions } from './graph-jev'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphOutcome, GraphScreenRequest } from './graph-plan-types'

function screenMarkdown(request: GraphScreenRequest, screen: JevScreen): string {
  const top = Object.entries(screen.scores)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([id, score], index) => {
      const text = request.candidates.find((candidate) => candidate.id === id)?.text ?? id
      return `${index + 1}. ${text.slice(0, 120)} (${score.toFixed(1)})`
    })
  return [
    `JEV scored ${Object.keys(screen.scores).length} of ${request.candidates.length} options (0–4, ${screen.model}).`,
    ...(screen.unscored.length ? [`It could not score ${screen.unscored.length}.`] : []),
    '',
    'Highest scores:',
    ...top
  ].join('\n')
}

/**
 * The `GraphConfig.screenWithJev` of one run: the pool is screened once and the result kept, so
 * the run replays it and its view shows it. A transient failure (rate limit, overload, network,
 * timeout) on any candidate voids the whole page and is never written: the step fails with a
 * clear reason and Retry re-asks the whole page again, cheaply. A page where every miss is
 * non-transient is kept for good, with the misses named as a gap, so a replay ends the same way.
 */
export function createGraphJevScreener(options: GraphJevOptions & { screen?: typeof jevScreen }) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.screen!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`JEV screen is not recorded: ${call.id}`)
    }
    const result = await (options.screen ?? jevScreen)(request, {
      ...options,
      caller: 'workflow.screen'
    })
    const outcome: GraphOutcome =
      'failed' in result
        ? {
            value: {
              markdown: `JEV could not screen the options: ${result.failed}.`,
              error: result.failed
            }
          }
        : {
            value: {
              markdown: screenMarkdown(request, result),
              scores: result.scores,
              criteria: result.criteria,
              unscored: result.unscored,
              // Under decision rules only: find-screen@2 names why each option went unscored.
              ...(request.contract && result.unscoredReasons
                ? { unscoredReasons: result.unscoredReasons }
                : {}),
              // For calibration only: no workflow decision reads these yet.
              ...(result.certainty ? { certainty: result.certainty } : {}),
              ...(result.usage ? { usage: result.usage } : {}),
              calls: result.calls
            }
          }
    // A transient failure (rate limit, overload, network, timeout) is never written: Retry must
    // re-ask JEV for the whole page, not replay the same stale error forever.
    if (!('failed' in result) || !result.retryable) {
      options.store.write(call.id, {
        digest,
        outcome,
        ...('failed' in result ? { detail: result.failed } : {}),
        at: Date.now()
      })
    }
    if ('failed' in result) {
      options.log?.(`JEV could not screen the options: ${result.failed}.`)
    }
    return outcome
  }
}

/** One run's screener; its record file is opened only when a screen actually comes. */
export function graphJevScreenerForExecution(
  executionId: string,
  options: Omit<GraphJevOptions, 'store'> = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let screener: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    screener ??= createGraphJevScreener({
      ...options,
      store: GraphJevStore.forExecution(executionId)
    })
    return screener(call)
  }
}
