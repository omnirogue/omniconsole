import type {
  LocalWorkflowCallView,
  LocalWorkflowDiscoverFinding,
  LocalWorkflowDiscoverRun,
  LocalWorkflowSeatView
} from '../../../shared/local-workflow-view'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import type { LocalWorkflowStageDefinition } from './local-workflow-council-projection'
import type { WorkflowProgramSnapshot } from './workflow-execution-service'
import { tallyDiscoverV7Votes } from './presets/discover-v7-ledger'
import {
  DISCOVER_V7_VERIFY_LENSES,
  discoverV7Location,
  discoverV7VerifyCallId,
  type DiscoverV7Record,
  type DiscoverV7Vote
} from './presets/discover-v7-plan'
import {
  discoverV7EmptySummary,
  discoverV7RankedSummary,
  discoverV7ReportMarkdown,
  sortDiscoverV7Items,
  type DiscoverV7Report
} from './presets/discover-v7-report'
import {
  discoverV7SnapshotPlan,
  replayDiscoverV7,
  type DiscoverV7Lookup,
  type DiscoverV7Probe,
  type DiscoverV7Replay
} from './local-workflow-discover-replay'

function seatView(snapshot: WorkflowProgramSnapshot, seatId: string): LocalWorkflowSeatView {
  const seat = snapshot.seats.find((entry) => entry.id === seatId)
  return {
    seatId,
    agent: seat?.agent ?? 'claude',
    model: seat?.model ?? '',
    modelLabel: seat ? localWorkflowModelLabel(seat.agent, seat.model) : seatId,
    effort: seat?.effort ?? null
  }
}

/** A report on its own: its votes and the status they decide. Repeats are resolved afterwards. */
function findingView(
  snapshot: WorkflowProgramSnapshot,
  replay: DiscoverV7Replay,
  record: DiscoverV7Record,
  lookup: DiscoverV7Lookup,
  provisional: boolean
): LocalWorkflowDiscoverFinding {
  const { finding } = record
  const votes = (record.verifiers ?? []).map((seatId, index) => {
    const lens = DISCOVER_V7_VERIFY_LENSES[index]
    const probe: DiscoverV7Probe = provisional
      ? { state: 'pending' }
      : lookup(discoverV7VerifyCallId(record.id, lens))
    const vote = probe.state === 'done' ? (probe.value as DiscoverV7Vote) : undefined
    return {
      lens,
      seat: seatView(snapshot, seatId),
      state: probe.state,
      ...(vote ? { verdict: vote.verdict, reason: vote.reason } : {})
    }
  })
  // Two matching votes decide the outcome even while the third is still running.
  const decided = tallyDiscoverV7Votes(
    votes.map((vote) => (vote.verdict ? { verdict: vote.verdict, reason: '', evidence: '' } : null))
  )
  const status: LocalWorkflowDiscoverFinding['status'] =
    provisional || record.duplicateOf
      ? 'verifying'
      : !record.verifiers
        ? 'unverified'
        : decided !== 'unverified'
          ? decided
          : votes.some((vote) => vote.state === 'pending' || vote.state === 'running')
            ? 'verifying'
            : 'unverified'
  return {
    id: record.id,
    title: finding.title,
    location: discoverV7Location(finding),
    severity: finding.severity,
    lens: record.lensId,
    area: replay.areas[record.areaIndex]?.name ?? '',
    round: record.round,
    foundBy: seatView(snapshot, record.finderId),
    markdown: [
      `**Trigger:** ${finding.trigger}`,
      `**Scenario:** ${finding.scenario}`,
      `**Evidence:** ${finding.evidence}`,
      `**Fix:** ${finding.fix}`
    ].join('\n\n'),
    status,
    votes
  }
}

function buildDiscoverV7Run(
  snapshot: WorkflowProgramSnapshot,
  lookup: DiscoverV7Lookup
): { run: LocalWorkflowDiscoverRun; replay: DiscoverV7Replay } | undefined {
  const plan = discoverV7SnapshotPlan(snapshot)
  if (!plan) {
    return undefined
  }
  const replay = replayDiscoverV7(plan, lookup)
  const provisional = new Set(replay.provisional)
  const records = [...replay.ledger.records, ...replay.provisional]
  const own = new Map(
    records.map((record) => [
      record.id,
      findingView(snapshot, replay, record, lookup, provisional.has(record))
    ])
  )
  // A repeat shows its original's outcome and is not listed or counted apart, as in the program.
  const findings = records.map((record) => {
    const view = own.get(record.id)!
    const original = record.duplicateOf
    return original
      ? { ...view, status: own.get(original)?.status ?? 'verifying', duplicateOf: original }
      : view
  })
  const distinct = findings.filter((finding) => !finding.duplicateOf)
  const count = (status: LocalWorkflowDiscoverFinding['status']) =>
    distinct.filter((finding) => finding.status === status).length
  const counts = {
    found: findings.length,
    duplicates: findings.length - distinct.length,
    verifying: count('verifying'),
    confirmed: count('confirmed'),
    refuted: count('refuted'),
    unverified: count('unverified')
  }
  const rank = lookup('rank/final')
  const ranked = rank.state === 'done' ? (rank.value as DiscoverV7Report) : undefined
  // With nothing searched the program fails the run instead of writing an empty report.
  const report = ranked
    ? { summary: discoverV7RankedSummary(ranked, counts), items: sortDiscoverV7Items(ranked.items) }
    : replay.finished && replay.ledger.searched && !counts.confirmed && !counts.verifying
      ? {
          summary: discoverV7EmptySummary({
            ...counts,
            searched: replay.ledger.searched,
            failed: replay.ledger.failed
          }),
          items: []
        }
      : undefined
  return {
    replay,
    run: {
      areas: replay.areas,
      lenses: [...plan.config.lensIds],
      round: replay.round,
      maxRounds: plan.maxRounds,
      findings,
      counts,
      ...(report ? { report } : {}),
      dropped: [...replay.ledger.dropped]
    }
  }
}

function liveLookup(
  results: ReadonlyMap<string, unknown>,
  calls: readonly LocalWorkflowCallView[]
): DiscoverV7Lookup {
  const byId = new Map(calls.map((call) => [call.id, call]))
  return (callId) => {
    if (results.has(callId)) {
      return { state: 'done', value: results.get(callId) }
    }
    const call = byId.get(callId)
    if (call?.state === 'running') {
      return { state: 'running' }
    }
    // The program treats only a call whose persisted attempts ran out as a lasting null. Any
    // other failed or cancelled attempt runs again in this run or on Resume or Retry.
    const exhausted =
      (call?.state === 'failed' || call?.state === 'cancelled') && call.attempt >= call.attemptLimit
    return exhausted ? { state: 'failed' } : { state: 'pending' }
  }
}

export function projectDiscoverV7Run(
  snapshot: WorkflowProgramSnapshot,
  results: ReadonlyMap<string, unknown>,
  calls: readonly LocalWorkflowCallView[]
): LocalWorkflowDiscoverRun {
  try {
    const built = buildDiscoverV7Run(snapshot, liveLookup(results, calls))
    if (built) {
      return built.run
    }
  } catch {
    // A malformed accepted result must not blank the whole view.
  }
  return {
    areas: [],
    lenses: [...(snapshot.discover?.lensIds ?? [])],
    round: 0,
    maxRounds: 0,
    findings: [],
    counts: { found: 0, duplicates: 0, verifying: 0, confirmed: 0, refuted: 0, unverified: 0 },
    dropped: []
  }
}

/**
 * Nothing verifies once a run has stopped, failed or completed. A vote cut off by Stop, never
 * started, or owed to a Retry leaves its finding unverified instead of verifying forever, and it
 * shows as a vote that did not land: no dot pulses or waits. Only the shown status changes: the
 * replay that decides rounds and the report keeps reading the real call states, so a stopped run
 * never looks finished.
 */
export function settleFinishedDiscoverRun(run: LocalWorkflowDiscoverRun): LocalWorkflowDiscoverRun {
  const findings = run.findings.map((finding) => ({
    ...finding,
    status: finding.status === 'verifying' ? ('unverified' as const) : finding.status,
    votes: finding.votes.map((vote) =>
      vote.state === 'running' || vote.state === 'pending'
        ? { ...vote, state: 'failed' as const }
        : vote
    )
  }))
  // Counts cover distinct findings only, and every distinct verifying finding is now unverified.
  const { verifying, unverified } = run.counts
  return {
    ...run,
    findings,
    counts: { ...run.counts, verifying: 0, unverified: unverified + verifying }
  }
}

/** Only read for completed runs, where every planned call has a result or failed. */
export function discoverV7ResultMarkdown(
  snapshot: WorkflowProgramSnapshot,
  results: ReadonlyMap<string, unknown>
): string | undefined {
  try {
    const built = buildDiscoverV7Run(snapshot, (callId) =>
      results.has(callId) ? { state: 'done', value: results.get(callId) } : { state: 'failed' }
    )
    const report = built?.run.report
    if (!built || !report) {
      return undefined
    }
    const entries = (status: LocalWorkflowDiscoverFinding['status']) =>
      built.run.findings.filter((finding) => !finding.duplicateOf && finding.status === status)
    return discoverV7ReportMarkdown(report, entries('refuted'), entries('unverified'))
  } catch {
    return undefined
  }
}

/** Without call states every missing result counts as pending. */
export function discoverV7StageDefinitions(
  snapshot: WorkflowProgramSnapshot,
  results: ReadonlyMap<string, unknown>,
  calls: readonly LocalWorkflowCallView[] = []
): LocalWorkflowStageDefinition[] {
  let built: ReturnType<typeof buildDiscoverV7Run>
  try {
    built = buildDiscoverV7Run(snapshot, liveLookup(results, calls))
  } catch {
    built = undefined
  }
  const replay = built?.replay
  // Planned votes only: provisional findings may still be merged away or dropped by the budget.
  const votes = replay?.ledger.records.reduce(
    (total, record) => total + (record.verifiers?.length ?? 0),
    0
  )
  return [
    { id: 'scout', label: 'Scout', total: 1, summary: 'Map the code into areas' },
    {
      id: 'find',
      label: 'Find',
      // Each round's repeat check runs in Find once it is known to run.
      total: replay ? replay.findJobs + replay.repeatChecks : undefined,
      summary: replay?.round
        ? `Round ${replay.round} of ${replay.plan.maxRounds}`
        : 'Look for defects area by area'
    },
    {
      id: 'verify',
      label: 'Verify',
      total: votes,
      summary: 'Three independent votes per finding'
    },
    {
      id: 'rank',
      label: 'Rank',
      // Known to be skipped: nothing was confirmed, or nothing could be searched.
      total: replay?.finished && (!built?.run.counts.confirmed || !replay.ledger.searched) ? 0 : 1,
      summary: 'Merge and rank what is real'
    }
  ]
}
