import type { WorkflowProgramSnapshot } from './workflow-execution-service'
import {
  admitDiscoverV7Batch,
  applyDiscoverV7RepeatCheck,
  createDiscoverV7Ledger,
  fundDiscoverV7Extras,
  nextDiscoverV7Dry,
  planDiscoverV7RepeatCheck,
  startDiscoverV7Round
} from './presets/discover-v7-ledger'
import {
  DISCOVER_V7_VERIFY_LENSES,
  discoverV7FallbackArea,
  discoverV7FinderId,
  discoverV7RepeatCallId,
  discoverV7VerifierOffset,
  discoverV7Verifiers,
  discoverV7VerifyCallId,
  parseDiscoverV7FindingId,
  planDiscoverV7,
  type DiscoverV7Area,
  type DiscoverV7Batch,
  type DiscoverV7Ledger,
  type DiscoverV7Plan,
  type DiscoverV7Record,
  type DiscoverV7Repeats
} from './presets/discover-v7-plan'
import { discoverV7ConfigFromSnapshot } from './presets/discover-v7-config'

export type DiscoverV7Probe = { state: 'pending' | 'running' | 'done' | 'failed'; value?: unknown }
export type DiscoverV7Lookup = (callId: string) => DiscoverV7Probe
export type DiscoverV7Replay = {
  plan: DiscoverV7Plan
  areas: DiscoverV7Area[]
  ledger: DiscoverV7Ledger
  /**
   * The current round's reports while one of its finders or its repeat check is still out: the
   * program has not decided these yet and verifies none of them.
   */
  provisional: DiscoverV7Record[]
  round: number
  /** Finder jobs planned so far, and the repeat checks known to run: the Find stage's calls. */
  findJobs: number
  repeatChecks: number
  /** Every round the program will run has run and every planned vote has landed or failed. */
  finished: boolean
}

export function discoverV7SnapshotPlan(
  snapshot: WorkflowProgramSnapshot
): DiscoverV7Plan | undefined {
  try {
    return planDiscoverV7(discoverV7ConfigFromSnapshot(snapshot))
  } catch {
    return undefined
  }
}

const unsettledDiscoverV7Probe = (probe: DiscoverV7Probe) =>
  probe.state === 'pending' || probe.state === 'running'

/** Replays the program's deterministic rounds over whatever results exist so far. */
export function replayDiscoverV7(plan: DiscoverV7Plan, lookup: DiscoverV7Lookup): DiscoverV7Replay {
  const ledger = createDiscoverV7Ledger()
  const replay: DiscoverV7Replay = {
    plan,
    areas: [],
    ledger,
    provisional: [],
    round: 0,
    findJobs: 0,
    repeatChecks: 0,
    finished: false
  }
  const scout = lookup('scout/map')
  if (unsettledDiscoverV7Probe(scout)) {
    return replay
  }
  replay.areas =
    scout.state === 'done'
      ? (scout.value as { areas: DiscoverV7Area[] }).areas
      : [discoverV7FallbackArea(plan.config)]
  let dry = 0
  for (let round = 1; round <= plan.maxRounds; round++) {
    const jobs = startDiscoverV7Round(plan, ledger, replay.areas, round)
    if (!jobs.length) {
      break
    }
    replay.round = round
    replay.findJobs += jobs.length
    // Nothing of a round is decided before its last finder and its repeat check are in.
    const roundStart = ledger.records.length
    let target = ledger
    const batches = jobs.map((job) => {
      const probe = lookup(job.callId)
      if (unsettledDiscoverV7Probe(probe)) {
        if (target === ledger) {
          target = { ...ledger, records: [...ledger.records], dropped: [] }
        }
        return null
      }
      const batch = probe.state === 'done' ? (probe.value as DiscoverV7Batch) : null
      admitDiscoverV7Batch(plan, target, replay.areas, job, batch)
      return batch
    })
    if (target !== ledger) {
      replay.provisional = target.records.slice(roundStart)
      ledger.records.splice(roundStart)
      return replay
    }
    fundDiscoverV7Extras(plan, ledger, replay.areas, jobs, batches)
    const candidates = planDiscoverV7RepeatCheck(plan, ledger, round)
    if (candidates) {
      replay.repeatChecks += 1
      const check = lookup(discoverV7RepeatCallId(round))
      if (unsettledDiscoverV7Probe(check)) {
        replay.provisional = ledger.records.splice(roundStart)
        return replay
      }
      const answer = check.state === 'done' ? (check.value as DiscoverV7Repeats) : null
      applyDiscoverV7RepeatCheck(ledger, candidates, answer)
    }
    // Votes never hold the next round back: it depends only on what the finders reported.
    const next = nextDiscoverV7Dry(plan, ledger, round, dry)
    dry = next.dry
    if (next.stop) {
      break
    }
  }
  replay.finished = !ledger.records.some((record) =>
    DISCOVER_V7_VERIFY_LENSES.some(
      (lens, index) =>
        record.verifiers?.[index] !== undefined &&
        unsettledDiscoverV7Probe(lookup(discoverV7VerifyCallId(record.id, lens)))
    )
  )
  return replay
}

/** Seat for a revision 7 call id, derived from the frozen config alone. */
export function discoverV7CallSeatId(
  snapshot: WorkflowProgramSnapshot,
  callId: string
): string | undefined {
  if (callId === 'scout/map' || callId === 'rank/final' || /^find\/r\d+\/repeats$/.test(callId)) {
    return snapshot.synthesizerId
  }
  const plan = discoverV7SnapshotPlan(snapshot)
  const find = /^find\/r(\d+)\/(\d+)\/([a-z-]+)$/.exec(callId)
  if (plan && find) {
    const lensIndex = plan.config.lensIds.indexOf(find[3])
    return lensIndex === -1
      ? undefined
      : discoverV7FinderId(plan, Number(find[2]), lensIndex, Number(find[1]))
  }
  const verify = /^verify\/(.+)\/([a-z]+)$/.exec(callId)
  const lensIndex = verify
    ? (DISCOVER_V7_VERIFY_LENSES as readonly string[]).indexOf(verify[2])
    : -1
  const parsed = plan && verify ? parseDiscoverV7FindingId(plan, verify[1]) : undefined
  if (!plan || !parsed || lensIndex === -1) {
    return undefined
  }
  const offset = discoverV7VerifierOffset(parsed.job, parsed.index)
  return discoverV7Verifiers(plan, parsed.job.seatId, offset)[lensIndex]
}
