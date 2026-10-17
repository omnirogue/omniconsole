import type { ArmRun } from './benchmark-report'

/** Round-tagged calls only; Brief, Scout and Report remain in the run total. */
export function summarizeDiscoverRounds(runs: readonly ArmRun[]) {
  return [
    ...new Set(
      runs.flatMap((run) => [
        ...(run.result?.results.targets.map((target) => target.round) ?? []),
        ...(run.result?.calls.flatMap((call) => {
          const round = /\/r(\d+)(?:\/|$)/.exec(call.id)
          return round ? [Number(round[1])] : []
        }) ?? [])
      ])
    )
  ]
    .sort((a, b) => a - b)
    .map((round) => {
      const targets = runs.flatMap(
        (run) => run.result?.results.targets.filter((target) => target.round === round) ?? []
      )
      const calls = runs.flatMap(
        (run) =>
          run.result?.calls.filter((call) => new RegExp(`/r${round}(?:/|$)`).test(call.id)) ?? []
      )
      const priced = calls.filter((call) => typeof call.costUsd === 'number')
      return {
        round,
        targets: targets.length,
        confirmed: targets.filter((target) => target.tally === 'confirmed').length,
        knownCostUsd: priced.length
          ? priced.reduce((sum, call) => sum + (call.costUsd as number), 0)
          : ('unknown' as const),
        unpricedCalls: calls.filter((call) => call.costUsd === 'unknown' || call.costPartial).length
      }
    })
}
