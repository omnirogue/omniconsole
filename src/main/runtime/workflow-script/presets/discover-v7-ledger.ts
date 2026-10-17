import {
  DISCOVER_MAX_FINDINGS_PER_JOB,
  DISCOVER_VOTES_PER_FINDING,
  discoverRoundBudget
} from '../../../../shared/local-workflow-draft'
import { discoverV7DuplicateOf } from './discover-v7-dedup'
import {
  discoverV7DepthLabel,
  discoverV7FindingId,
  discoverV7LensLabel,
  discoverV7Path,
  discoverV7Plural,
  discoverV7VerifierOffset,
  discoverV7Verifiers,
  discoverV7Jobs,
  type DiscoverV7Area,
  type DiscoverV7Batch,
  type DiscoverV7Job,
  type DiscoverV7Ledger,
  type DiscoverV7Plan,
  type DiscoverV7RawFinding,
  type DiscoverV7Record,
  type DiscoverV7Repeats,
  type DiscoverV7RoundJob,
  type DiscoverV7Status,
  type DiscoverV7Vote
} from './discover-v7-plan'

/**
 * Budget, dedup and loop-until-dry bookkeeping for Discover revision 7. The program applies these
 * as results arrive and the projection replays them over accepted results, in the same order.
 * A round starts only the finder jobs whose every possible finding can still get its votes, so no
 * fresh finding is ever left unverified for want of agents.
 */

export function createDiscoverV7Ledger(): DiscoverV7Ledger {
  // The scout call is always planned first.
  return {
    used: 1,
    jobsRun: 0,
    repeatCheck: 0,
    searched: 0,
    failed: 0,
    records: [],
    dropped: []
  }
}

/** Calls still free for Find and Verify, keeping one in reserve for Rank. */
function available(plan: DiscoverV7Plan, ledger: DiscoverV7Ledger): number {
  return plan.config.maxAgents - ledger.used - 1
}

function jobLabel(areas: readonly DiscoverV7Area[], job: DiscoverV7Job): string {
  return `${areas[job.areaIndex]?.name ?? `Area ${job.areaIndex + 1}`} · ${discoverV7LensLabel(job.lensId)}`
}

/**
 * The order the budget serves jobs in: every area's first lens before any area's second, starting
 * where earlier rounds stopped, so a tight cap trims lenses across all areas instead of skipping
 * the same last areas every round.
 */
function servingOrder(jobs: readonly DiscoverV7Job[], start: number): DiscoverV7Job[] {
  const spread = [...jobs].sort(
    (left, right) => left.lensIndex - right.lensIndex || left.areaIndex - right.areaIndex
  )
  const offset = spread.length ? start % spread.length : 0
  return [...spread.slice(offset), ...spread.slice(0, offset)]
}

function limitLine(
  plan: DiscoverV7Plan,
  round: number,
  limits: readonly number[],
  reportLimit: number
): string | null {
  const most = Math.max(...limits)
  const least = Math.min(...limits)
  if (!limits.length || least >= DISCOVER_MAX_FINDINGS_PER_JOB) {
    return null
  }
  const total = limits.reduce((sum, limit) => sum + limit, 0)
  const share =
    most === least ? discoverV7Plural(most, 'finding', 'findings') : `${least} or ${most} findings`
  const further =
    reportLimit > least
      ? `; a job may report up to ${reportLimit}, and findings past its share get the votes other jobs leave unused`
      : ''
  return `Round ${round}: ${discoverV7Plural(total, 'new finding', 'new findings')} can get ${total === 1 ? 'its' : 'their'} ${DISCOVER_VOTES_PER_FINDING} votes within ${plan.config.maxAgents} agents, so each finder job keeps votes for ${share}${further}.`
}

/**
 * Plans one round's finder jobs within the agent budget, reserves the votes their findings could
 * need, and records what the cap dropped or limited. A job may report past its share, up to all
 * the round can verify (at most the schema's limit): what one job leaves, another can use. A run
 * admitted before that rule (firstRules) replays with each job reporting only its share.
 */
export function startDiscoverV7Round(
  plan: DiscoverV7Plan,
  ledger: DiscoverV7Ledger,
  areas: readonly DiscoverV7Area[],
  round: number
): DiscoverV7RoundJob[] {
  const jobs = discoverV7Jobs(plan, areas, round)
  const { findingLimits, repeatCheck } = discoverRoundBudget(available(plan, ledger), jobs.length)
  const reserved = findingLimits.reduce((total, limit) => total + limit, 0)
  const pooled = plan.config.firstRules ? 0 : Math.min(DISCOVER_MAX_FINDINGS_PER_JOB, reserved)
  const served = servingOrder(jobs, ledger.jobsRun).slice(0, findingLimits.length)
  const limitOf = new Map(served.map((job, index) => [job.callId, findingLimits[index]]))
  // Kept jobs still run in area order, which is also the order dedup admits their batches.
  const selected = jobs.flatMap((job) => {
    const findingLimit = limitOf.get(job.callId)
    return findingLimit === undefined
      ? []
      : [{ ...job, findingLimit, reportLimit: Math.max(findingLimit, pooled) }]
  })
  if (selected.length < jobs.length) {
    const skipped = jobs
      .filter((job) => !limitOf.has(job.callId))
      .map((job) => jobLabel(areas, job))
    ledger.dropped.push(
      `Round ${round}: skipped ${skipped.length} of ${discoverV7Plural(jobs.length, 'finder job', 'finder jobs')} to stay within ${plan.config.maxAgents} agents (${skipped.join('; ')}).`
    )
  }
  const limited = limitLine(plan, round, findingLimits, pooled)
  if (limited) {
    ledger.dropped.push(limited)
  }
  ledger.used += selected.length + reserved * DISCOVER_VOTES_PER_FINDING + repeatCheck
  ledger.repeatCheck = repeatCheck
  ledger.jobsRun += selected.length
  return selected
}

/** Records one reported finding: a repeat of a verified report, or a fresh one with its verifiers. */
function recordFinding(
  plan: DiscoverV7Plan,
  ledger: DiscoverV7Ledger,
  job: DiscoverV7Job,
  finding: DiscoverV7RawFinding,
  index: number
): DiscoverV7Record {
  const original = discoverV7DuplicateOf(ledger.records, finding, plan.config.workspaceRoot)
  const record: DiscoverV7Record = {
    id: discoverV7FindingId(job, index),
    round: job.round,
    areaIndex: job.areaIndex,
    lensId: job.lensId,
    findCallId: job.callId,
    finderId: job.seatId,
    finding,
    ...(original
      ? { duplicateOf: original }
      : { verifiers: discoverV7Verifiers(plan, job.seatId, discoverV7VerifierOffset(job, index)) })
  }
  ledger.records.push(record)
  return record
}

/**
 * Dedups the job's share of one finder batch in code against every report so far, gives each
 * fresh finding its verifiers and returns the votes the job reserved but did not need; the rest
 * wait for fundDiscoverV7Extras. Callers must admit batches in job order: the first
 * report of a defect is the one that gets verified. The code key only catches close wording; the
 * round's repeat check groups what it misses before anything is verified.
 */
export function admitDiscoverV7Batch(
  plan: DiscoverV7Plan,
  ledger: DiscoverV7Ledger,
  areas: readonly DiscoverV7Area[],
  job: DiscoverV7RoundJob,
  batch: DiscoverV7Batch | null
): DiscoverV7Record[] {
  const release = (fresh: number) => {
    ledger.used -= (job.findingLimit - fresh) * DISCOVER_VOTES_PER_FINDING
  }
  if (!batch) {
    ledger.failed += 1
    release(0)
    return []
  }
  ledger.searched += 1
  const left = batch.omitted + Math.max(0, batch.findings.length - job.reportLimit)
  if (left > 0) {
    ledger.dropped.push(
      `Round ${job.round}, ${jobLabel(areas, job)}: the finder left out ${discoverV7Plural(left, 'more finding', 'more findings')} beyond its limit of ${job.reportLimit}.`
    )
  }
  const fresh = batch.findings
    .slice(0, job.findingLimit)
    .map((finding, index) => recordFinding(plan, ledger, job, finding, index))
    .filter((record) => record.verifiers)
  release(fresh.length)
  return fresh
}

/**
 * Once every batch of the round is in, the votes jobs kept but did not need go to findings past
 * other jobs' shares, breadth first in job order. A repeat needs no votes and is always recorded;
 * what finds none is set aside and logged. Returns how many further findings got votes: none for a
 * run admitted before rules 2, whose jobs report only their share.
 */
export function fundDiscoverV7Extras(
  plan: DiscoverV7Plan,
  ledger: DiscoverV7Ledger,
  areas: readonly DiscoverV7Area[],
  jobs: readonly DiscoverV7RoundJob[],
  batches: readonly (DiscoverV7Batch | null)[]
): number {
  if (!jobs.length) {
    return 0
  }
  const round = jobs[0].round
  const kept = jobs.reduce((total, job) => total + job.findingLimit, 0)
  let spare = kept - freshDiscoverV7Records(ledger, round).length
  let funded = 0
  const setAside = new Map<DiscoverV7RoundJob, number>()
  const deepest = Math.max(...jobs.map((job) => job.reportLimit - job.findingLimit))
  for (let extra = 0; extra < deepest; extra++) {
    for (const [position, job] of jobs.entries()) {
      const index = job.findingLimit + extra
      const finding = index < job.reportLimit ? batches[position]?.findings[index] : undefined
      if (!finding) {
        continue
      }
      if (spare < 1 && !discoverV7DuplicateOf(ledger.records, finding, plan.config.workspaceRoot)) {
        setAside.set(job, (setAside.get(job) ?? 0) + 1)
        continue
      }
      if (recordFinding(plan, ledger, job, finding, index).verifiers) {
        spare -= 1
        funded += 1
        ledger.used += DISCOVER_VOTES_PER_FINDING
      }
    }
  }
  if (setAside.size) {
    const total = [...setAside.values()].reduce((sum, count) => sum + count, 0)
    const where = jobs
      .filter((job) => setAside.has(job))
      .map((job) => `${jobLabel(areas, job)}: ${setAside.get(job)}`)
    ledger.dropped.push(
      `Round ${round}: set aside ${discoverV7Plural(total, 'finding', 'findings')} beyond what the round could verify within ${plan.config.maxAgents} agents (${where.join('; ')}).`
    )
  }
  return funded
}

/** The round's reports that are not repeats: after its repeat check, the ones to verify. */
export function freshDiscoverV7Records(
  ledger: DiscoverV7Ledger,
  round: number
): DiscoverV7Record[] {
  return ledger.records.filter((record) => record.round === round && !record.duplicateOf)
}

/**
 * Once a round's last batch is admitted: the new findings its repeat check must group, which is
 * every one of them when two share a file (the same file is where rewordings of one defect land),
 * or undefined when no check runs, and then its kept call goes back to the budget.
 */
export function planDiscoverV7RepeatCheck(
  plan: DiscoverV7Plan,
  ledger: DiscoverV7Ledger,
  round: number
): DiscoverV7Record[] | undefined {
  const fresh = freshDiscoverV7Records(ledger, round)
  const paths = fresh.map((record) =>
    discoverV7Path(record.finding.file, plan.config.workspaceRoot)
  )
  const shared = new Set(paths).size < paths.length
  const kept = ledger.repeatCheck
  ledger.repeatCheck = 0
  if (shared && kept) {
    return fresh
  }
  ledger.used -= kept
  if (shared) {
    ledger.dropped.push(
      `Round ${round}: no agent was left to check ${fresh.length} new findings for repeats, so each one is verified.`
    )
  }
  return undefined
}

/**
 * Records the repeats a check grouped: in each group the first report in job order is the one
 * verified and the rest repeat it, giving back their votes. A check that did not answer (null)
 * merges nothing. Returns the findings still to verify, in job order.
 */
export function applyDiscoverV7RepeatCheck(
  ledger: DiscoverV7Ledger,
  candidates: readonly DiscoverV7Record[],
  answer: DiscoverV7Repeats | null
): DiscoverV7Record[] {
  const order = new Map(candidates.map((record, index) => [record.id, index]))
  for (const group of answer?.groups ?? []) {
    const [original, ...repeats] = group.findingIds
      .map((id) => order.get(id))
      .filter((index): index is number => index !== undefined)
      .toSorted((left, right) => left - right)
      .map((index) => candidates[index])
    for (const repeat of repeats) {
      repeat.duplicateOf = original.id
      delete repeat.verifiers
      ledger.used -= DISCOVER_VOTES_PER_FINDING
    }
  }
  return candidates.filter((record) => !record.duplicateOf)
}

/** Deep-research tally: two real votes confirm, two refutes kill, a missing vote never kills. */
export function tallyDiscoverV7Votes(votes: readonly (DiscoverV7Vote | null)[]): DiscoverV7Status {
  const real = votes.filter((vote) => vote?.verdict === 'real').length
  const refuted = votes.filter((vote) => vote?.verdict === 'refuted').length
  return real >= 2 ? 'confirmed' : refuted >= 2 ? 'refuted' : 'unverified'
}

/** Loop-until-dry bookkeeping shared by the program and its replay. */
export function nextDiscoverV7Dry(
  plan: DiscoverV7Plan,
  ledger: DiscoverV7Ledger,
  round: number,
  dry: number
): { dry: number; stop: boolean } {
  const fresh = freshDiscoverV7Records(ledger, round).length
  const next = fresh ? 0 : dry + 1
  if (next >= plan.dryLimit) {
    return { dry: next, stop: true }
  }
  if (round >= plan.maxRounds) {
    if (plan.maxRounds > 1 && fresh) {
      ledger.dropped.push(
        `Stopped at the ${discoverV7DepthLabel(plan.config.depth)} limit of ${plan.maxRounds} rounds; round ${round} still found ${discoverV7Plural(fresh, 'new finding', 'new findings')}.`
      )
    }
    return { dry: next, stop: true }
  }
  return { dry: next, stop: false }
}
