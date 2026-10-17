import type { WorkflowProgramContext } from '../workflow-program-context'
import {
  admitDiscoverV7Batch,
  applyDiscoverV7RepeatCheck,
  createDiscoverV7Ledger,
  freshDiscoverV7Records,
  fundDiscoverV7Extras,
  nextDiscoverV7Dry,
  planDiscoverV7RepeatCheck,
  startDiscoverV7Round,
  tallyDiscoverV7Votes
} from './discover-v7-ledger'
import {
  DISCOVER_V7_VERIFY_LENSES,
  discoverV7FallbackArea,
  discoverV7Plural,
  planDiscoverV7,
  type DiscoverV7Area,
  type DiscoverV7Batch,
  type DiscoverV7Config,
  type DiscoverV7Ledger,
  type DiscoverV7Plan,
  type DiscoverV7Record,
  type DiscoverV7Repeats,
  type DiscoverV7RoundJob,
  type DiscoverV7Vote
} from './discover-v7-plan'
import {
  discoverV7FindCall,
  discoverV7RepeatCall,
  discoverV7ScoutCall,
  discoverV7VerifyCall,
  lastingDiscoverV7Agent
} from './discover-v7-calls'
import { finishDiscoverV7, type DiscoverV7Settled } from './discover-v7-finish'

export type { DiscoverV7Config } from './discover-v7-plan'

type Task = { prompt: string; evidence: string }
type Run = {
  context: WorkflowProgramContext
  plan: DiscoverV7Plan
  task: Task
  areas: readonly DiscoverV7Area[]
  ledger: DiscoverV7Ledger
  flushDropped: () => void
}

/**
 * Votes run beside everything else: a round's verification never holds back the next round's
 * finders, which depend only on what earlier finders reported. Every vote is still awaited before
 * the program returns or fails, so no call outlives it.
 */
function createVoting(
  context: WorkflowProgramContext,
  plan: DiscoverV7Plan,
  task: Task,
  verdicts: Map<string, DiscoverV7Settled>
) {
  const pending: Promise<void>[] = []
  let failure: { error: unknown } | undefined
  let announced = false
  return {
    verify(fresh: DiscoverV7Record[]) {
      if (!fresh.length) {
        return
      }
      if (!announced) {
        announced = true
        context.phase('Verify')
      }
      const cast = context.parallel(
        fresh.map(
          (record) => () =>
            context.parallel(
              DISCOVER_V7_VERIFY_LENSES.map(
                (_, lensIndex) => () =>
                  lastingDiscoverV7Agent(
                    context,
                    discoverV7VerifyCall(plan, task, record, lensIndex)
                  )
              )
            )
        )
      ) as Promise<((DiscoverV7Vote | null)[] | null)[]>
      pending.push(
        cast.then(
          (votes) =>
            fresh.forEach((record, position) => {
              const ballot = votes[position] ?? DISCOVER_V7_VERIFY_LENSES.map(() => null)
              verdicts.set(record.id, {
                record,
                votes: ballot,
                status: tallyDiscoverV7Votes(ballot)
              })
            }),
          (error: unknown) => {
            failure ??= { error }
          }
        )
      )
    },
    /** Resolves once every vote started so far has landed or failed; it never rejects. */
    settled: () => Promise.all(pending),
    throwIfFailed() {
      if (failure) {
        throw failure.error
      }
    }
  }
}

/**
 * Every finder of the round runs at once. A batch is admitted the moment every earlier job's
 * batch is in, so code dedup, ids and the budget follow job order whatever order finders finish
 * in. Admitting a batch before an earlier one is in would let completion order decide which copy
 * of a defect gets verified. Once all are in, the votes jobs did not need go to the findings past
 * other jobs' shares. Nothing is verified yet: the round's repeat check comes first.
 */
async function findRound(run: Run, jobs: DiscoverV7RoundJob[]): Promise<void> {
  const { context, plan, task, areas, ledger } = run
  const known = ledger.records.filter((record) => !record.duplicateOf)
  const batches: (DiscoverV7Batch | null | undefined)[] = jobs.map(() => undefined)
  let next = 0
  let halted = false
  const admitReady = () => {
    for (; !halted && next < jobs.length && batches[next] !== undefined; next++) {
      admitDiscoverV7Batch(plan, ledger, areas, jobs[next], batches[next] ?? null)
      run.flushDropped()
    }
  }
  await context.parallel(
    jobs.map((job, index) => async () => {
      try {
        const batch = await lastingDiscoverV7Agent(
          context,
          discoverV7FindCall(plan, task, areas, job, known)
        )
        batches[index] = (batch as DiscoverV7Batch | null) ?? null
      } finally {
        // A job that threw holds admission until the round settles: a fatal error ends the run.
        halted ||= batches[index] === undefined
      }
      admitReady()
    })
  )
  // Only reached when nothing failed fatally; a job that threw otherwise searched nothing.
  halted = false
  batches.forEach((batch, index) => {
    batches[index] = batch ?? null
  })
  admitReady()
  const funded = fundDiscoverV7Extras(
    plan,
    ledger,
    areas,
    jobs,
    batches as (DiscoverV7Batch | null)[]
  )
  run.flushDropped()
  if (funded) {
    context.log(
      `Round ${jobs[0].round}: ${discoverV7Plural(funded, 'more finding gets', 'more findings get')} the votes other finder jobs did not need.`
    )
  }
}

/**
 * Once every finder of the round is in: when two new findings share a file, one call on the
 * ranker seat groups all of them by root cause, and only the first report of each group is
 * verified. The code key misses rewordings of one defect; verifying each would spend three votes
 * on a defect already being verified. Returns the findings to verify.
 */
async function checkRepeats(run: Run, jobs: DiscoverV7RoundJob[]): Promise<DiscoverV7Record[]> {
  const { context, plan, task, ledger } = run
  const round = jobs[0].round
  const candidates = planDiscoverV7RepeatCheck(plan, ledger, round)
  run.flushDropped()
  if (!candidates) {
    return freshDiscoverV7Records(ledger, round)
  }
  const answer = (await lastingDiscoverV7Agent(
    context,
    discoverV7RepeatCall(plan, task, jobs, candidates)
  )) as DiscoverV7Repeats | null
  const fresh = applyDiscoverV7RepeatCheck(ledger, candidates, answer)
  const repeats = candidates.length - fresh.length
  context.log(
    !answer
      ? `Round ${round}: the repeat check did not answer, so all ${candidates.length} new findings are verified.`
      : repeats
        ? `Round ${round}: the repeat check found ${discoverV7Plural(repeats, 'repeat', 'repeats')} among ${candidates.length} new findings, so ${fresh.length} are verified.`
        : `Round ${round}: the repeat check found no repeats among ${candidates.length} new findings.`
  )
  return fresh
}

export async function runDiscoverV7Program(
  context: WorkflowProgramContext,
  config: DiscoverV7Config,
  task: Task
) {
  const plan = planDiscoverV7(config)
  const ledger = createDiscoverV7Ledger()
  let logged = 0
  const flushDropped = () => {
    ledger.dropped.slice(logged).forEach((line) => context.log(line))
    logged = ledger.dropped.length
  }
  context.phase('Scout')
  const map = (await lastingDiscoverV7Agent(context, discoverV7ScoutCall(plan, task))) as {
    areas: DiscoverV7Area[]
  } | null
  const areas = map?.areas ?? [discoverV7FallbackArea(config)]
  context.log(
    map
      ? `Scout mapped ${discoverV7Plural(areas.length, 'area', 'areas')}: ${areas.map((area) => area.name).join('; ')}`
      : 'Scout did not return a map; searching the whole focus as one area.'
  )
  const verdicts = new Map<string, DiscoverV7Settled>()
  const voting = createVoting(context, plan, task, verdicts)
  const run: Run = { context, plan, task, areas, ledger, flushDropped }
  try {
    let dry = 0
    for (let round = 1; round <= plan.maxRounds; round++) {
      const jobs = startDiscoverV7Round(plan, ledger, areas, round)
      flushDropped()
      if (!jobs.length) {
        break
      }
      context.phase('Find')
      context.log(
        `Round ${round} of ${plan.maxRounds}: ${discoverV7Plural(jobs.length, 'finder job', 'finder jobs')}`
      )
      const before = { records: ledger.records.length, failed: ledger.failed }
      await findRound(run, jobs)
      voting.verify(await checkRepeats(run, jobs))
      const reported = ledger.records.slice(before.records)
      const failed = ledger.failed - before.failed
      context.log(
        `Round ${round}: ${reported.length} reported, ${reported.filter((record) => !record.duplicateOf).length} new${failed ? `; ${failed} of ${discoverV7Plural(jobs.length, 'finder job', 'finder jobs')} returned nothing` : ''}`
      )
      const next = nextDiscoverV7Dry(plan, ledger, round, dry)
      flushDropped()
      dry = next.dry
      if (next.stop) {
        break
      }
    }
  } finally {
    await voting.settled()
  }
  voting.throwIfFailed()
  if (!ledger.searched) {
    // Nothing was searched, so an empty report would claim a clean result it never checked.
    throw new Error('Discover could not search the code: no finder returned a result.')
  }
  return finishDiscoverV7(context, plan, task, { areas, ledger, verdicts })
}
