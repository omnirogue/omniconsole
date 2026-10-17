import { z } from 'zod'

const cost = z.union([z.number().finite().nonnegative(), z.literal('unknown')])
const finding = z.object({
  key: z.string(),
  round: z.number().int().positive(),
  tally: z.enum(['confirmed', 'refuted', 'unverified']),
  title: z.string(),
  detail: z.string(),
  location: z.string(),
  sourceCallId: z.string().optional(),
  alsoFrom: z.array(z.string()).optional(),
  label: z
    .object({
      pick: z.enum(['Start', 'Dig deeper']),
      outcome: z.enum(['launched', 'completed', 'failed', 'unknown'])
    })
    .optional()
})
export const discoverStatsRunSchema = z.object({
  host: z.string().min(1),
  runId: z.string().uuid(),
  template: z.string(),
  goal: z.string().optional(),
  workspace: z.string().optional(),
  at: z.number().finite(),
  state: z.string(),
  degraded: z.boolean(),
  substitutions: z.number().int().nonnegative(),
  delivery: z.enum(['published', 'pending', 'failed', 'unknown', 'isolated']),
  rounds: z.array(
    z.object({
      round: z.number().int().positive(),
      newFindings: z.number().int().nonnegative(),
      confirmed: z.number().int().nonnegative()
    })
  ),
  calls: z.array(
    z.object({
      id: z.string(),
      step: z.string(),
      round: z.number().int().nonnegative(),
      model: z.string(),
      lens: z.string(),
      costUsd: cost,
      costPartial: z.boolean().optional()
    })
  ),
  findings: z.array(finding)
})
export type DiscoverStatsRun = z.infer<typeof discoverStatsRunSchema>
export const discoverStatsExportSchema = z
  .object({
    version: z.literal(1),
    runs: z.array(discoverStatsRunSchema),
    unreadable: z.number().int().nonnegative().default(0)
  })
  .strict()
export type DiscoverStatsExport = z.infer<typeof discoverStatsExportSchema>

type CostBucket = {
  costUsd: number | 'unknown'
  knownCalls: number
  unknownCalls: number
  partial: boolean
}
function sumCost(calls: DiscoverStatsRun['calls']): CostBucket {
  const known = calls.filter((call) => typeof call.costUsd === 'number')
  return {
    costUsd: known.length ? known.reduce((sum, call) => sum + Number(call.costUsd), 0) : 'unknown',
    knownCalls: known.length,
    unknownCalls: calls.length - known.length,
    partial: known.length < calls.length || calls.some((call) => call.costPartial === true)
  }
}

/** Merge identities before summing; conflicting copies refuse rather than silently double count. */
export function mergeDiscoverExports(exports: DiscoverStatsExport[]): DiscoverStatsExport {
  const runs = new Map<string, DiscoverStatsRun>()
  const unique = [...new Map(exports.map((entry) => [JSON.stringify(entry), entry])).values()]
  for (const entry of unique) {
    for (const run of entry.runs) {
      const key = JSON.stringify([run.host, run.runId])
      const prior = runs.get(key)
      if (prior && JSON.stringify(prior) !== JSON.stringify(run)) {
        throw new Error(
          `Conflicting exports for ${run.host}/${run.runId}; export one current snapshot per host.`
        )
      }
      runs.set(key, run)
    }
  }
  return {
    version: 1,
    runs: [...runs.values()],
    unreadable: unique.reduce((sum, entry) => sum + entry.unreadable, 0)
  }
}

export function discoverStats(data: DiscoverStatsExport) {
  const states: Record<string, number> = {}
  const delivery: Record<string, number> = {}
  const rounds = new Map<
    number,
    { round: number; runs: number; newFindings: number; confirmed: number }
  >()
  const steps = new Map<string, DiscoverStatsRun['calls']>()
  const contributors = new Map<
    string,
    { lens: string; model: string; reported: number; confirmed: number }
  >()
  const labels = {
    Start: { launched: 0, completed: 0, failed: 0, unknown: 0 },
    'Dig deeper': { launched: 0, completed: 0, failed: 0, unknown: 0 }
  }
  for (const run of data.runs) {
    states[run.state] = (states[run.state] ?? 0) + 1
    delivery[run.delivery] = (delivery[run.delivery] ?? 0) + 1
    for (const row of run.rounds) {
      const total = rounds.get(row.round) ?? {
        round: row.round,
        runs: 0,
        newFindings: 0,
        confirmed: 0
      }
      total.runs++
      total.newFindings += row.newFindings
      total.confirmed += row.confirmed
      rounds.set(row.round, total)
    }
    for (const call of run.calls) {
      const key = `${call.step}/r${call.round}`
      const entries = steps.get(key) ?? []
      entries.push(call)
      steps.set(key, entries)
    }
    for (const item of run.findings) {
      if (item.label) {
        labels[item.label.pick][item.label.outcome]++
      }
      const credited = new Set<string>()
      for (const id of new Set([item.sourceCallId, ...(item.alsoFrom ?? [])])) {
        const call =
          run.calls.find((entry) => entry.id.startsWith(`${id}~`)) ??
          run.calls.find((entry) => entry.id === id)
        const lens = call?.lens ?? 'unknown',
          model = call?.model ?? 'unknown'
        const key = JSON.stringify([lens, model])
        if (credited.has(key)) {
          continue
        }
        credited.add(key)
        const row = contributors.get(key) ?? { lens, model, reported: 0, confirmed: 0 }
        row.reported++
        row.confirmed += Number(item.tally === 'confirmed')
        contributors.set(key, row)
      }
    }
  }
  return {
    runs: data.runs.length,
    unreadable: data.unreadable,
    outcomes: {
      states,
      delivery,
      degraded: data.runs.filter((run) => run.degraded).length,
      substitutions: data.runs.reduce((sum, run) => sum + run.substitutions, 0)
    },
    rounds: [...rounds.values()].sort((a, b) => a.round - b.round),
    cost: sumCost(data.runs.flatMap((run) => run.calls)),
    steps: [...steps]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stepRound, calls]) => ({ stepRound, ...sumCost(calls) })),
    contributors: [...contributors.values()],
    labels,
    precision: 'unknown' as const,
    precisionNote:
      'Start and Dig deeper outcomes are behavioral labels, not correctness verdicts. Blind adjudication has not been imported.',
    export: data
  }
}
export type WorkflowDiscoverStats = ReturnType<typeof discoverStats>

/** Deterministic stratified sample; no verdict, votes, model identity or action label escapes. */
export function discoverBlindReview(data: DiscoverStatsExport, perVerdict: number) {
  const samples = data.runs.flatMap((run) => run.findings.map((item) => ({ run, item })))
  const hash = (value: string) => {
    let result = 2166136261
    for (const char of value) {
      result = Math.imul(result ^ char.charCodeAt(0), 16777619)
    }
    return (result >>> 0).toString(16).padStart(8, '0')
  }
  const id = (row: (typeof samples)[number]) => `${row.run.host}/${row.run.runId}/${row.item.key}`
  const chosen = ['confirmed', 'refuted'].flatMap((tally) =>
    samples
      .filter((row) => row.item.tally === tally)
      .sort((a, b) => hash(id(a)).localeCompare(hash(id(b))) || id(a).localeCompare(id(b)))
      .slice(0, perVerdict)
  )
  return {
    version: 1,
    note: 'Blind sample of confirmed and refuted findings. Adjudicate each claim independently.',
    samples: chosen
      .sort((a, b) => hash(`blind:${id(a)}`).localeCompare(hash(`blind:${id(b)}`)))
      .map((row) => ({
        sampleId: hash(id(row)),
        ...(row.run.goal ? { goal: row.run.goal } : {}),
        ...(row.run.workspace ? { workspace: row.run.workspace } : {}),
        title: row.item.title,
        detail: row.item.detail,
        location: row.item.location
      }))
  }
}
