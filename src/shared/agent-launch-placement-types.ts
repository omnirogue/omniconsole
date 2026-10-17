/**
 * Contract for `omni session launch --project` placement and `omni host list --capacity`
 * (docs/reference/agent-launch.md). Placement is ranked once, frozen into the launch record
 * before any effect, and never re-ranked on retry, as WorkflowPlacement is
 * (local-workflow-placement.ts).
 */

import type { LaunchAccountBound, LaunchAccountChoice } from './account-launch-verdict'
import type {
  AgentLaunchHostId,
  AgentLaunchLoad,
  AgentLaunchLoadBand,
  AgentLaunchReadinessAccount
} from './agent-launch-account'
import type { ExecutionHostId } from './execution-host'
import type { CapacityProvider } from './provider-account-capacity'

export const LAUNCH_PLACEMENT_RULE = 'v1' as const
export const LAUNCH_PLACEMENT_CONCURRENCY = 3
export const LAUNCH_PLACEMENT_DEADLINE_MS = 45_000
export const LAUNCH_PLACEMENT_STATUS_TIMEOUT_MS = 8_000
export const LAUNCH_PLACEMENT_SETUP_TIMEOUT_MS = 8_000
export const LAUNCH_PLACEMENT_READINESS_TIMEOUT_MS = 30_000

/** Shown for a reachable computer whose OmniConsole cannot verify accounts for a launch. */
export const LAUNCH_OLD_RUNTIME_NOTE =
  'launch needs OmniConsole update (no agent-session.verified-account-launch.v1)'

/**
 * How the launch reaches the computer. `ssh` is a target registered on this computer and is
 * driven through this computer's runtime; targets behind a paired runtime are not ranked yet.
 */
export type LaunchPlacementRoute =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; name: string }
  | { kind: 'ssh'; targetId: string; label: string }

/**
 * - `fresh`: every check passed (reachable, capability, readiness answered, ready setup,
 *   idempotent create for git, verified account, not hot); the rank decides.
 * - `unverifiable`: missed its deadline or the transport failed; never idle, never zero.
 * - `duplicate`: the same machine as a better route; listed so nothing is double-counted.
 */
export type LaunchCandidateState =
  | 'fresh'
  | 'unverifiable'
  | 'old-runtime'
  | 'no-setup'
  | 'no-idempotent-create'
  | 'unverified-account'
  | 'hot'
  | 'nested-ssh'
  | 'duplicate'

/** A ready project setup on the candidate; `selector` is what readiness and launch resolve. */
export type LaunchCandidateSetup = {
  projectId: string
  /** The setup's own host id on the computer that registered it. */
  hostId: ExecutionHostId
  repoId?: string
  path: string
  kind: 'git' | 'folder'
  /** `id:<repoId>::<path>` for git, `path:<path>` for a folder. */
  selector: string
}

export type LaunchCandidate = {
  /** Placement dedupe key (readiness `machineId`, else status `sessionHost.hostId`). */
  machineId: string | null
  label: string
  route: LaunchPlacementRoute
  isThisComputer: boolean
  appVersion: string | null
  /** agent-session.verified-account-launch.v1 */
  launchCapability: boolean
  /** worktree.create-idempotency.v1, required to create a git worktree for the launch. */
  idempotentCreate: boolean
  reachable: boolean
  checkedAt: number
  runtimeId: string | null
  /** Executing host as readiness resolved it; null until readiness answers. */
  hostId: AgentLaunchHostId | null
  state: LaunchCandidateState
  reason: string
  setup: LaunchCandidateSetup | null
  /** Ready setups of the project on this route, for the capacity view. */
  setupCount: number
  account: AgentLaunchReadinessAccount | null
  load: AgentLaunchLoad | null
}

/** What the record keeps of every candidate looked at; enough for the refusal text. */
export type LaunchPlacementCandidateSummary = {
  label: string
  route: LaunchPlacementRoute
  machineId: string | null
  state: LaunchCandidateState
  reason: string
}

export type LaunchPlacementChosen = {
  machineId: string | null
  route: LaunchPlacementRoute
  environmentId?: string
  hostId: AgentLaunchHostId
  runtimeId: string
  label: string
  setup: LaunchCandidateSetup
  remainingPercent: number
  band: AgentLaunchLoadBand
  why: string
}

/** Frozen with the pick: after a refusal, the command is printed, never auto-advanced to. */
export type LaunchPlacementRunnerUp = {
  label: string
  route: LaunchPlacementRoute
  command: string
}

/**
 * `new-worktree`: idempotent `worktree.create` on `repoSelector` (`id:<repoId>`) named `name`.
 * `folder`: launch into the shared folder at `path` (the receipt warns that it is shared).
 */
export type LaunchWorkspacePlan = {
  kind: 'new-worktree' | 'folder'
  repoSelector?: string
  name?: string
  path?: string
}

export type LaunchPlacementProject = {
  /** As typed after --project. */
  input: string
  /** getProjectIdentityKey; a `repo:` key is host-local, so only this computer can match. */
  identityKey: string
  name: string | null
}

/** Frozen in the launch record before any effect; a retry reads this, never the fleet. */
export type LaunchPlacement = {
  rule: typeof LAUNCH_PLACEMENT_RULE
  rankedAt: number
  project: LaunchPlacementProject
  chosen: LaunchPlacementChosen
  runnerUp: LaunchPlacementRunnerUp | null
  candidates: LaunchPlacementCandidateSummary[]
  workspacePlan: LaunchWorkspacePlan
  /** Journaled before the first create and kept on a resend; the host's window counts from it. */
  worktreeCreateSentAt?: number
  /** The runtime that got that create; a restart forgets its dedupe record, so a resend could duplicate. */
  worktreeCreateRuntimeId?: string
  /** Journaled as soon as the create answers, so a retry after the TTL never creates twice. */
  createdWorktreeId?: string
  /** The host's warning about that create (for example a failed first terminal), for the receipt. */
  createdWorktreeWarning?: string
}

/** The host dedupes creates by this id for its TTL; the record covers the time after it. */
export function launchWorktreeClientMutationId(operationId: string): string {
  return `launch-${operationId}`
}

/**
 * - `fresh`: at least one account with a fresh verified reading and room left.
 * - `unverifiable`: the computer did not answer in time; `none`: it has no accounts.
 */
export type LaunchCapacityFreshness =
  | 'fresh'
  | 'limited'
  | 'stale'
  | 'unknown'
  | 'signed-out'
  | 'unverifiable'
  | 'none'

export type LaunchCapacityAccounts = {
  freshness: LaunchCapacityFreshness
  bestRemainingPercent: number | null
  boundBy: LaunchAccountBound | null
  readingAgeMs: number | null
  verifiedCount: number
  consideredCount: number
  limitedUntil?: number
  /** `accounts-list`: read-only from an older runtime, so a launch there is not offered. */
  source: 'readiness' | 'accounts-list'
}

export type LaunchCapacityRoute = {
  route: LaunchPlacementRoute
  label: string
  reachable: boolean
}

/** One row per physical computer (deduped by machine id) in `omni host list --capacity`. */
export type LaunchCapacityRow = {
  label: string
  machineId: string | null
  routes: LaunchCapacityRoute[]
  isThisComputer: boolean
  reachable: boolean
  checkedAt: number
  appVersion: string | null
  launchCapability: boolean
  accounts: Partial<Record<CapacityProvider, LaunchCapacityAccounts>>
  load: AgentLaunchLoad | null
  /** Null without --project. */
  project: { identityKey: string; present: boolean; setups: number } | null
  /**
   * Rule v1 could pick this computer now. Without --project: a launch named with --host there,
   * into a workspace on it.
   */
  eligible: boolean
  reason: string
  recommendedCommand?: string
}

export type LaunchCapacityView = {
  provider: CapacityProvider
  model: string | null
  project: LaunchPlacementProject | null
  checkedAt: number
  rows: LaunchCapacityRow[]
}

const UNAVAILABLE_ORDER: LaunchCapacityFreshness[] = ['limited', 'stale', 'unknown', 'signed-out']

function worstCaseFreshness(states: readonly string[]): LaunchCapacityFreshness {
  return UNAVAILABLE_ORDER.find((state) => states.includes(state)) ?? 'none'
}

function earliest(untils: readonly (number | undefined)[]): number | undefined {
  const known = untils.filter((until): until is number => until !== undefined)
  return known.length ? Math.min(...known) : undefined
}

/** A new runtime's readiness preview, summarised for the capacity row. */
export function launchCapacityFromReadiness(
  account: AgentLaunchReadinessAccount
): LaunchCapacityAccounts {
  if (account.verified) {
    const { receipt } = account
    return {
      freshness: 'fresh',
      bestRemainingPercent: receipt.remainingPercent,
      boundBy: receipt.boundBy,
      readingAgeMs: receipt.readingAgeMs,
      verifiedCount: receipt.verified ?? 1,
      consideredCount: receipt.considered ?? receipt.verified ?? 1,
      source: 'readiness'
    }
  }
  const states = account.accounts.map((candidate) => candidate.state)
  const limitedUntil = earliest(
    account.accounts.filter((a) => a.state === 'limited').map((a) => a.until)
  )
  return {
    // Why: a refusal with no rows (an SSH relay error) is unknown, not "no accounts".
    freshness: states.length ? worstCaseFreshness(states) : 'unknown',
    bestRemainingPercent: null,
    boundBy: null,
    readingAgeMs: null,
    verifiedCount: 0,
    consideredCount: states.filter((state) => state !== 'not-considered').length,
    ...(limitedUntil !== undefined ? { limitedUntil } : {}),
    source: 'readiness'
  }
}

/** An older runtime's `accounts.list` rows, classified by chooseVerifiedLaunchAccount. */
export function launchCapacityFromChoice(
  choice: LaunchAccountChoice,
  now: number
): LaunchCapacityAccounts {
  const considered = choice.verdicts.filter((entry) => entry.verdict.state !== 'not-considered')
  const verifiedCount = considered.filter((entry) => entry.verdict.state === 'fresh').length
  const limitedUntil = earliest(
    considered.map((entry) => (entry.verdict.state === 'limited' ? entry.verdict.until : undefined))
  )
  const { pick } = choice
  return {
    freshness: pick ? 'fresh' : worstCaseFreshness(considered.map((entry) => entry.verdict.state)),
    bestRemainingPercent: pick?.verdict.remainingPercent ?? null,
    boundBy: pick?.verdict.boundBy ?? null,
    readingAgeMs: pick?.row.readingAt != null ? Math.max(0, now - pick.row.readingAt) : null,
    verifiedCount,
    consideredCount: considered.length,
    ...(limitedUntil !== undefined && !pick ? { limitedUntil } : {}),
    source: 'accounts-list'
  }
}
