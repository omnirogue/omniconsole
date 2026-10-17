/**
 * Rule v1 of `omni session launch --project`: which computer takes a launch, and why none can.
 * Pure, like chooseWorkflowFleetHost / workflowFleetPlacementRefusal (local-workflow-placement.ts):
 * the CLI reads every candidate once, ranks here, and freezes the pick into the launch record.
 */

import type { AgentLaunchLoadBand } from './agent-launch-account'
import {
  launchCapacityFromReadiness,
  LAUNCH_OLD_RUNTIME_NOTE,
  type LaunchCandidate,
  type LaunchCandidateState,
  type LaunchPlacementCandidateSummary,
  type LaunchPlacementRoute
} from './agent-launch-placement-types'
import { isHostLocalProjectId } from './project-host-setup-projection'
import type { CapacityProvider } from './provider-account-capacity'

export type LaunchPlacementContext = { provider: CapacityProvider; project: string }

export type LaunchPlacementRanking = {
  /** Every candidate with its final state: the ranked ones first, then the rest as read. */
  candidates: LaunchCandidate[]
  /** Eligible, deduped by machine and sorted; [0] is the pick, [1] the runner-up. */
  ranked: LaunchCandidate[]
  chosen: LaunchCandidate | null
  runnerUp: LaunchCandidate | null
  why: string
}

const BAND_RANK: Record<AgentLaunchLoadBand, number> = { ok: 0, offload: 1, unknown: 2, hot: 3 }

export function launchCandidateBand(candidate: LaunchCandidate): AgentLaunchLoadBand {
  return candidate.load?.band ?? 'unknown'
}

export function launchCandidateRemainingPercent(candidate: LaunchCandidate): number | null {
  return candidate.account?.verified ? candidate.account.receipt.remainingPercent : null
}

export function launchPlacementRouteKey(route: LaunchPlacementRoute): string {
  return route.kind === 'local'
    ? 'local'
    : route.kind === 'environment'
      ? `runtime:${route.environmentId}`
      : `ssh:${route.targetId}`
}

// Why: a paired runtime executes its own workspaces; an SSH route adds a relay hop.
function routeRank(candidate: LaunchCandidate): number {
  return candidate.route.kind === 'ssh' ? 1 : 0
}

function headroomBucket(candidate: LaunchCandidate): number {
  return Math.floor((launchCandidateRemainingPercent(candidate) ?? 0) / 10)
}

// Why: plain code-unit order, so the pick never depends on the invoking computer's locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Only observed available bytes: no per-model RAM estimate or new pressure threshold. */
function memoryHeadroom(candidate: LaunchCandidate): number | null {
  const { freeBytes, totalBytes } = candidate.load ?? {}
  return typeof freeBytes === 'number' &&
    Number.isFinite(freeBytes) &&
    freeBytes >= 0 &&
    typeof totalBytes === 'number' &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    freeBytes <= totalBytes
    ? freeBytes
    : null
}

function compareMemory(a: LaunchCandidate, b: LaunchCandidate): number {
  const left = memoryHeadroom(a)
  const right = memoryHeadroom(b)
  // Missing is unknown; a measured host with no available memory comes last.
  const rank = (bytes: number | null) => (bytes === null ? 1 : bytes === 0 ? 2 : 0)
  return rank(left) - rank(right) || (right ?? 0) - (left ?? 0)
}

function compareLaunchCandidates(a: LaunchCandidate, b: LaunchCandidate): number {
  return (
    BAND_RANK[launchCandidateBand(a)] - BAND_RANK[launchCandidateBand(b)] ||
    compareMemory(a, b) ||
    headroomBucket(b) - headroomBucket(a) ||
    Number(b.isThisComputer) - Number(a.isThisComputer) ||
    routeRank(a) - routeRank(b) ||
    compareText(a.label, b.label) ||
    compareText(launchPlacementRouteKey(a.route), launchPlacementRouteKey(b.route))
  )
}

/** Within one machine: the most exact headroom, then the paired runtime (ssh-execution-boundary.md). */
function compareSameMachine(a: LaunchCandidate, b: LaunchCandidate): number {
  return (
    (launchCandidateRemainingPercent(b) ?? 0) - (launchCandidateRemainingPercent(a) ?? 0) ||
    routeRank(a) - routeRank(b) ||
    compareLaunchCandidates(a, b)
  )
}

function clockTime(at: number): string {
  return new Date(at).toTimeString().slice(0, 5)
}

function loadText(candidate: LaunchCandidate): string {
  const { load } = candidate
  return load ? `${load.loadPerCore.toFixed(2)} load per core (${load.band})` : 'load unknown'
}

function accountRefusalText(candidate: LaunchCandidate, provider: CapacityProvider): string {
  const account = candidate.account
  if (!account || account.verified) {
    return `${provider} capacity unverifiable`
  }
  const capacity = launchCapacityFromReadiness(account)
  switch (capacity.freshness) {
    case 'limited':
      return capacity.limitedUntil !== undefined
        ? `${provider} limited until ${clockTime(capacity.limitedUntil)}`
        : `${provider} limited`
    case 'signed-out':
      return `${provider} signed out`
    case 'stale':
      return `${provider} readings stale (none at most 60 s old)`
    case 'none':
      return `no ${provider} account`
    case 'fresh':
    case 'unknown':
    case 'unverifiable':
      return `${provider} capacity unknown: ${account.refusal}`
  }
}

type Verdict = { state: LaunchCandidateState; reason: string }

/**
 * Why a candidate can or cannot take the launch. A state the reader already decided (with the
 * reader's words, as `omni host list --capacity` shows it) stands; a `fresh` one is re-checked
 * against every eligibility rule, so no reader slip can place a launch where it must not go.
 */
export function launchCandidateVerdict(
  candidate: LaunchCandidate,
  context: LaunchPlacementContext
): Verdict {
  const { state, reason } = candidate
  if (state !== 'fresh') {
    return { state, reason }
  }
  const version = candidate.appVersion ?? 'version unknown'
  const { setup, account } = candidate
  if (!candidate.reachable || candidate.runtimeId === null || candidate.hostId === null) {
    return { state: 'unverifiable', reason: 'did not answer (unverifiable)' }
  }
  if (!candidate.launchCapability) {
    return { state: 'old-runtime', reason: `OmniConsole ${version}: ${LAUNCH_OLD_RUNTIME_NOTE}` }
  }
  // Why: a git setup without a repository record has no repo to create the launch worktree from.
  if (!setup || (setup.kind === 'git' && !setup.repoId)) {
    return { state: 'no-setup', reason: `no ready setup of ${context.project} that can take it` }
  }
  if (setup.kind === 'git' && !candidate.idempotentCreate) {
    return {
      state: 'no-idempotent-create',
      reason: `OmniConsole ${version} cannot create the launch worktree idempotently (no worktree.create-idempotency.v1)`
    }
  }
  if (!account?.verified) {
    return { state: 'unverified-account', reason: accountRefusalText(candidate, context.provider) }
  }
  if (candidate.load?.band === 'hot') {
    return { state: 'hot', reason: loadText(candidate) }
  }
  const bound = account.receipt.boundBy ? ` (${account.receipt.boundBy})` : ''
  return {
    state: 'fresh',
    reason: reason || `${account.receipt.remainingPercent}% left${bound}, ${loadText(candidate)}`
  }
}

/** Load per core measures the whole machine, so one route's hot reading excludes every route to it. */
function excludeHotMachines(judged: LaunchCandidate[]): LaunchCandidate[] {
  const hot = new Map<string, LaunchCandidate>()
  for (const candidate of judged) {
    if (candidate.machineId !== null && candidate.load?.band === 'hot') {
      hot.set(candidate.machineId, hot.get(candidate.machineId) ?? candidate)
    }
  }
  return judged.map((candidate) => {
    const measured = candidate.machineId === null ? undefined : hot.get(candidate.machineId)
    return candidate.state === 'fresh' && measured
      ? {
          ...candidate,
          state: 'hot',
          reason: `same computer as ${measured.label}, measured ${loadText(measured)}`
        }
      : candidate
  })
}

/** One winner per machine id; routes without one are never merged (nothing double-counts). */
function dedupeByMachine(eligible: LaunchCandidate[]): {
  winners: LaunchCandidate[]
  duplicates: LaunchCandidate[]
} {
  const best = new Map<string, LaunchCandidate>()
  for (const candidate of eligible) {
    if (candidate.machineId === null) {
      continue
    }
    const current = best.get(candidate.machineId)
    if (!current || compareSameMachine(candidate, current) < 0) {
      best.set(candidate.machineId, candidate)
    }
  }
  const winners: LaunchCandidate[] = []
  const duplicates: LaunchCandidate[] = []
  for (const candidate of eligible) {
    const winner = candidate.machineId === null ? candidate : best.get(candidate.machineId)
    if (winner === candidate) {
      winners.push(candidate)
    } else {
      duplicates.push({
        ...candidate,
        state: 'duplicate',
        reason: `same computer as ${winner!.label}, which has the better route`
      })
    }
  }
  return { winners, duplicates }
}

function headroomText(candidate: LaunchCandidate): string {
  return `${launchCandidateRemainingPercent(candidate) ?? 0}%`
}

/** What decided the pick over the runner-up, in rule v1's order. */
export function launchPlacementWhy(
  chosen: LaunchCandidate,
  runnerUp: LaunchCandidate | null
): string {
  const own = `${headroomText(chosen)} left, ${launchCandidateBand(chosen)} load`
  if (!runnerUp) {
    return `the only computer that can take it now (${own})`
  }
  const other = runnerUp.label
  if (BAND_RANK[launchCandidateBand(chosen)] !== BAND_RANK[launchCandidateBand(runnerUp)]) {
    return `lower load than ${other} (${launchCandidateBand(chosen)} vs ${launchCandidateBand(runnerUp)})`
  }
  if (compareMemory(chosen, runnerUp) !== 0) {
    const free = memoryHeadroom(chosen)
    const otherFree = memoryHeadroom(runnerUp)
    return free !== null && otherFree !== null
      ? `more available memory than ${other} (${(free / 1024 ** 3).toFixed(1)} vs ${(otherFree / 1024 ** 3).toFixed(1)} GiB)`
      : free !== null
        ? `measured available memory; ${other}'s memory is unknown`
        : `${other} has no available memory; this computer's memory is unknown`
  }
  if (headroomBucket(chosen) !== headroomBucket(runnerUp)) {
    return `more fresh headroom than ${other} (${headroomText(chosen)} vs ${headroomText(runnerUp)})`
  }
  const tie = `${other} has the same load band and headroom (${own})`
  if (chosen.isThisComputer !== runnerUp.isThisComputer) {
    return `this computer first; ${tie}`
  }
  if (routeRank(chosen) !== routeRank(runnerUp)) {
    return `paired runtime before SSH; ${tie}`
  }
  return `name order; ${tie}`
}

/** Rule v1: CPU band, measured RAM, account headroom bucket, this computer, route, label. */
export function rankLaunchCandidates(
  candidates: readonly LaunchCandidate[],
  context: LaunchPlacementContext
): LaunchPlacementRanking {
  const judged = excludeHotMachines(
    candidates.map((candidate) => ({
      ...candidate,
      ...launchCandidateVerdict(candidate, context)
    }))
  )
  const { winners, duplicates } = dedupeByMachine(
    judged.filter((candidate) => candidate.state === 'fresh')
  )
  const ranked = winners.sort(compareLaunchCandidates)
  const rest = judged.filter((candidate) => candidate.state !== 'fresh')
  const chosen = ranked[0] ?? null
  const runnerUp = ranked[1] ?? null
  return {
    candidates: [...ranked, ...duplicates, ...rest],
    ranked,
    chosen,
    runnerUp,
    why: chosen ? launchPlacementWhy(chosen, runnerUp) : ''
  }
}

export function launchCandidateSummary(
  candidate: LaunchCandidate
): LaunchPlacementCandidateSummary {
  return {
    label: candidate.label,
    route: candidate.route,
    machineId: candidate.machineId,
    state: candidate.state,
    reason: candidate.reason
  }
}

/** R17: every computer looked at and why it cannot take the launch; never a fallback. */
export function launchPlacementRefusal(args: {
  provider: CapacityProvider
  project: string
  candidates: readonly LaunchPlacementCandidateSummary[]
}): string {
  const lines = args.candidates.length
    ? args.candidates.map((candidate) => `  ${candidate.label}: ${candidate.reason}`)
    : ['  no computer could be looked at']
  // Why: a repo: id is minted per computer, so no other computer can hold the same project.
  const scope = isHostLocalProjectId(args.project)
    ? [`  (${args.project} is this computer's own project id, so no other computer was looked at)`]
    : []
  return [
    `No computer can take this ${args.provider} launch for ${args.project} now:`,
    ...lines,
    ...scope,
    'Nothing launched.'
  ].join('\n')
}
