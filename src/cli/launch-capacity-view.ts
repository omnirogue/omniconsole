/**
 * `omni host list --capacity`: one row per physical computer, with its fresh account headroom and
 * load, built from the same candidate reads and rule v1 ranking `session launch --project` places
 * with. Routes merge only by machine id; an older runtime is read-only and never launchable.
 */

import { launchPlacementRouteKey, rankLaunchCandidates } from '../shared/agent-launch-placement'
import {
  LAUNCH_OLD_RUNTIME_NOTE,
  launchCapacityFromReadiness,
  type LaunchCapacityAccounts,
  type LaunchCapacityRow,
  type LaunchCapacityView
} from '../shared/agent-launch-placement-types'
import type { EnvironmentSummary, SshTargetSummary } from './host-selector-alternatives'
import type { LaunchCandidateQuery, LaunchCandidateReading } from './launch-candidate-reader'
import { capacityLaunchCommand } from './launch-capacity-commands'
import { launchPlacementHostFlag, launchPlacementHostFlagText } from './launch-placement-target'

export type LaunchCapacityResult = LaunchCapacityView & {
  /** What to run next; null when no computer can take the launch now. */
  recommendedCommand: string | null
  notes: string[]
}

export type LaunchHostNames = {
  environments: EnvironmentSummary[]
  sshTargets: SshTargetSummary[]
}

export const CAPACITY_ROUTE_WORD = { local: 'local', environment: 'paired', ssh: 'ssh' } as const
const ROUTE_ORDER = { local: 0, environment: 1, ssh: 2 } as const

/** A reading as placement judged it; `rank` is its place among the computers it would pick from. */
type RankedReading = LaunchCandidateReading & { rank: number | null }

function rankReadings(
  readings: readonly LaunchCandidateReading[],
  query: LaunchCandidateQuery
): RankedReading[] {
  // Why placement's own rule: a row is launchable exactly when `--project` could pick it.
  const ranking = rankLaunchCandidates(
    readings.map(({ candidate }) => candidate),
    { provider: query.provider, project: query.project?.identityKey ?? 'the workspace' }
  )
  const judged = new Map(
    ranking.candidates.map((entry) => [launchPlacementRouteKey(entry.route), entry])
  )
  const ranks = new Map(
    ranking.ranked.map((entry, index) => [launchPlacementRouteKey(entry.route), index])
  )
  return readings.map((reading) => {
    const key = launchPlacementRouteKey(reading.candidate.route)
    return {
      ...reading,
      candidate: judged.get(key) ?? reading.candidate,
      rank: ranks.get(key) ?? null
    }
  })
}

/** Null when nothing was read (an SSH route without a workspace here, or an old route to it). */
function readingAccounts(reading: LaunchCandidateReading): LaunchCapacityAccounts | null {
  const { candidate } = reading
  if (candidate.account) {
    return launchCapacityFromReadiness(candidate.account)
  }
  if (reading.listedAccounts) {
    return reading.listedAccounts
  }
  if (candidate.reachable && candidate.state !== 'unverifiable') {
    return null
  }
  return {
    freshness: 'unverifiable',
    bestRemainingPercent: null,
    boundBy: null,
    readingAgeMs: null,
    verifiedCount: 0,
    consideredCount: 0,
    source: candidate.launchCapability ? 'readiness' : 'accounts-list'
  }
}

/** Within one machine: the ranked route, then the most headroom, then the runtime over SSH. */
function routePreference(a: RankedReading, b: RankedReading): number {
  return (
    (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
    (readingAccounts(b)?.bestRemainingPercent ?? -1) -
      (readingAccounts(a)?.bestRemainingPercent ?? -1) ||
    ROUTE_ORDER[a.candidate.route.kind] - ROUTE_ORDER[b.candidate.route.kind] ||
    Number(b.candidate.reachable) - Number(a.candidate.reachable)
  )
}

function groupByMachine(readings: readonly RankedReading[]): RankedReading[][] {
  const groups: RankedReading[][] = []
  const byMachine = new Map<string, RankedReading[]>()
  for (const reading of readings) {
    const machineId = reading.candidate.machineId
    const group = machineId === null ? undefined : byMachine.get(machineId)
    if (group) {
      group.push(reading)
      continue
    }
    groups.push([reading])
    if (machineId !== null) {
      byMachine.set(machineId, groups.at(-1)!)
    }
  }
  return groups
}

function capacityRow(
  group: readonly RankedReading[],
  query: LaunchCandidateQuery,
  names: LaunchHostNames
): { row: LaunchCapacityRow; rank: number | null } {
  const [best, ...others] = [...group].sort(routePreference)
  const { candidate, rank } = best!
  const label =
    group.find((reading) => reading.candidate.isThisComputer)?.candidate.label ??
    group.find((reading) => reading.candidate.route.kind === 'environment')?.candidate.label ??
    candidate.label
  const accounts = readingAccounts(best!)
  const eligible = rank !== null
  const also = others.map(
    ({ candidate: other }) => `${other.label} (${CAPACITY_ROUTE_WORD[other.route.kind]})`
  )
  const hostFlag = launchPlacementHostFlagText(
    launchPlacementHostFlag(candidate.route, names.environments, names.sshTargets)
  )
  const row: LaunchCapacityRow = {
    label,
    machineId: candidate.machineId,
    routes: group.map(({ candidate: entry }) => ({
      route: entry.route,
      label: entry.label,
      reachable: entry.reachable
    })),
    isThisComputer: group.some((reading) => reading.candidate.isThisComputer),
    reachable: group.some((reading) => reading.candidate.reachable),
    checkedAt: candidate.checkedAt,
    appVersion: candidate.appVersion,
    launchCapability: candidate.launchCapability,
    accounts: accounts ? { [query.provider]: accounts } : {},
    load: candidate.load,
    project: query.project
      ? {
          identityKey: query.project.identityKey,
          present: group.some((reading) => reading.candidate.setupCount > 0),
          setups: group.reduce((sum, reading) => sum + reading.candidate.setupCount, 0)
        }
      : null,
    eligible,
    reason: also.length
      ? `${candidate.reason}; also reached as ${also.join(', ')}`
      : candidate.reason,
    ...(eligible
      ? {
          recommendedCommand: capacityLaunchCommand({
            provider: query.provider,
            model: query.model,
            projectKey: query.project?.identityKey ?? null,
            hostFlag,
            worktreePlaceholder: !query.project && candidate.route.kind !== 'local'
          })
        }
      : {})
  }
  return { row, rank }
}

/** Launchable rows in placement order; the rest after them, this computer first, then by name. */
function rowOrder(
  a: { row: LaunchCapacityRow; rank: number | null },
  b: { row: LaunchCapacityRow; rank: number | null }
): number {
  const kind = ({ row }: { row: LaunchCapacityRow }) =>
    Math.min(...row.routes.map(({ route }) => ROUTE_ORDER[route.kind]))
  return (
    (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
    Number(b.row.isThisComputer) - Number(a.row.isThisComputer) ||
    kind(a) - kind(b) ||
    a.row.label.localeCompare(b.row.label)
  )
}

function viewNotes(rows: readonly LaunchCapacityRow[], query: LaunchCandidateQuery): string[] {
  const notes: string[] = []
  const old = rows.filter(
    (row) =>
      row.reachable &&
      !row.launchCapability &&
      !row.routes.some(({ route }) => route.kind === 'ssh')
  )
  if (old.length > 0) {
    const labels = old.map((row) => row.label).join(', ')
    notes.push(`Read-only until updated (${LAUNCH_OLD_RUNTIME_NOTE}): ${labels}.`)
  }
  const unmerged = rows.filter(
    (row) =>
      row.machineId === null &&
      rows.some((other) => other !== row && other.label.toLowerCase() === row.label.toLowerCase())
  )
  if (unmerged.length > 0) {
    const labels = [...new Set(unmerged.map((row) => row.label))].join(', ')
    notes.push(`Not merged without a machine id, so each route has its own row: ${labels}.`)
  }
  if (!rows.some((row) => row.eligible)) {
    const scope = query.project ? ` for ${query.project.identityKey}` : ''
    notes.push(`No computer can take this ${query.provider} launch${scope} now. Nothing to launch.`)
  } else if (!query.project) {
    notes.push('Or pass --project <id> and the command picks the computer and the account.')
  }
  return notes
}

export function launchCapacityView(args: {
  query: LaunchCandidateQuery
  readings: readonly LaunchCandidateReading[]
  names: LaunchHostNames
  checkedAt: number
}): LaunchCapacityResult {
  const { query } = args
  const rows = groupByMachine(rankReadings(args.readings, query))
    .map((group) => capacityRow(group, query, args.names))
    .sort(rowOrder)
    .map(({ row }) => row)
  const recommendedCommand = !rows[0]?.eligible
    ? null
    : query.project
      ? capacityLaunchCommand({
          provider: query.provider,
          model: query.model,
          projectKey: query.project.identityKey,
          hostFlag: null,
          worktreePlaceholder: false
        })
      : (rows[0].recommendedCommand ?? null)
  return {
    provider: query.provider,
    model: query.model,
    project: query.project,
    checkedAt: args.checkedAt,
    rows,
    recommendedCommand,
    notes: viewNotes(rows, query)
  }
}
