/**
 * The pure half of the launch candidate reader (launch-candidate-reader.ts): which ready setup of
 * a project a computer launches into, and the state its reads put it in. Placement ranks only
 * `fresh` candidates; every other state says why, for the refusal and the capacity view.
 */

import type {
  AgentLaunchReadinessAccount,
  AgentLaunchReadinessResult
} from '../shared/agent-launch-account'
import {
  LAUNCH_OLD_RUNTIME_NOTE,
  type LaunchCandidate,
  type LaunchCandidateSetup,
  type LaunchCandidateState,
  type LaunchPlacementProject,
  type LaunchPlacementRoute
} from '../shared/agent-launch-placement-types'
import { parseExecutionHostId, toSshExecutionHostId } from '../shared/execution-host'
import { isHostLocalProjectId } from '../shared/project-host-setup-projection'
import type { ProjectHostSetup } from '../shared/project-types'
import {
  AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY,
  WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
} from '../shared/protocol-version'
import type { CapacityProvider } from '../shared/provider-account-capacity'
import { getRepoMainWorktreeId } from '../shared/worktree/id'

export type LaunchStatusRead =
  | {
      ok: true
      runtimeId: string
      appVersion: string | null
      capabilities: readonly string[]
      /** status.get `sessionHost.hostId`: one per machine and OS user, when advertised. */
      sessionHostId: string | null
      /** status.get `hostPlatform`, when advertised. */
      hostPlatform?: string | null
    }
  | { ok: false; reason: string }

export type LaunchSetupsRead =
  | { ok: true; setups: readonly ProjectHostSetup[] }
  | { ok: false; reason: string; unsupported: boolean }

export type LaunchReadinessRead =
  | { ok: true; result: AgentLaunchReadinessResult }
  | { ok: false; reason: string; unreachable: boolean }

export type LaunchCandidateFacts = {
  route: LaunchPlacementRoute
  label: string
  isThisComputer: boolean
  checkedAt: number
  provider: CapacityProvider
  project: LaunchPlacementProject | null
  /** For an SSH route, this computer's status: its runtime drives the launch there. */
  status: LaunchStatusRead
  /** For an SSH route, this computer's setups (the SSH workspaces it registered). */
  setups: LaunchSetupsRead
  /** Null until asked: readiness needs the capability and a ready setup. */
  readiness: LaunchReadinessRead | null
}

/** Ready setups that run on this route; `nested` are SSH ones behind a paired runtime. */
export function launchRouteSetups(
  setups: readonly ProjectHostSetup[],
  route: LaunchPlacementRoute
): { own: ProjectHostSetup[]; nested: ProjectHostSetup[] } {
  const own: ProjectHostSetup[] = []
  const nested: ProjectHostSetup[] = []
  for (const setup of setups) {
    const host = setup.setupState === 'ready' ? parseExecutionHostId(setup.hostId) : null
    if (!host) {
      continue
    }
    if (route.kind === 'ssh') {
      if (host.kind === 'ssh' && host.targetId === route.targetId) {
        own.push(setup)
      }
    } else if (
      host.kind === 'local' ||
      (route.kind === 'environment' &&
        host.kind === 'runtime' &&
        host.environmentId === route.environmentId)
    ) {
      own.push(setup)
    } else if (route.kind === 'environment' && host.kind === 'ssh') {
      nested.push(setup)
    }
  }
  return { own, nested }
}

export function launchCandidateSetup(setup: ProjectHostSetup): LaunchCandidateSetup {
  const kind = setup.kind === 'folder' ? 'folder' : 'git'
  return {
    projectId: setup.projectId,
    hostId: setup.hostId,
    ...(kind === 'git' ? { repoId: setup.repoId } : {}),
    path: setup.path,
    kind,
    selector:
      kind === 'git'
        ? `id:${getRepoMainWorktreeId({ id: setup.repoId, path: setup.path })}`
        : `path:${setup.path}`
  }
}

/** Git first (a launch gets its own fresh worktree), then the oldest, usually the main checkout. */
export function chooseLaunchSetup(
  setups: readonly ProjectHostSetup[]
): LaunchCandidateSetup | null {
  const [first] = [...setups].sort(
    (a, b) =>
      Number(a.kind === 'folder') - Number(b.kind === 'folder') ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id)
  )
  return first ? launchCandidateSetup(first) : null
}

type Verdict = { state: LaunchCandidateState; reason: string }

/** Ready setups this route could not launch into, counted so the reason can say why. */
type SetupGaps = { nested: number; unrecorded: number }

// Why: a git setup without a repository record has no repo to create the launch worktree from.
function hasRepoRecord(setup: ProjectHostSetup): boolean {
  return setup.kind === 'folder' || Boolean(setup.repoId)
}

function unverifiedReason(
  account: AgentLaunchReadinessAccount | null,
  provider: CapacityProvider
): string {
  if (!account || account.verified) {
    return 'account capacity was not read'
  }
  if (account.accounts.length === 0) {
    return account.refusal.replace(/\s*Nothing launched\.?\s*$/, '')
  }
  const counts = new Map<string, number>()
  for (const { state } of account.accounts) {
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const states = [...counts].map(([state, count]) => `${state} ${count}`).join(', ')
  return `no ${provider} account with fresh verified capacity (${states})`
}

function noSetupVerdict(
  candidate: Omit<LaunchCandidate, 'state' | 'reason'>,
  project: LaunchPlacementProject | null,
  { nested, unrecorded }: SetupGaps
): Verdict {
  const { route } = candidate
  if (!project) {
    return {
      state: 'no-setup',
      reason:
        route.kind === 'ssh'
          ? 'no workspace on it is registered here, so its accounts cannot be read'
          : 'no project is set up there'
    }
  }
  const key = project.identityKey
  if (unrecorded > 0) {
    return {
      state: 'no-setup',
      reason: `its ready setup of ${key} has no repository record here; set it up again in the desktop app`
    }
  }
  if (nested > 0) {
    return {
      state: 'nested-ssh',
      reason: `${key} is set up only on SSH targets behind it (${nested}); nested SSH is not ranked yet`
    }
  }
  if (route.kind === 'environment' && isHostLocalProjectId(key)) {
    return {
      state: 'no-setup',
      reason: `${key} is this computer's own project id, so another computer cannot match it`
    }
  }
  const hint =
    route.kind === 'ssh'
      ? 'add it in the desktop app'
      : `omni project setup-clone --project ${key} --host ${route.kind === 'local' ? 'local' : `runtime:${route.environmentId}`} …`
  return { state: 'no-setup', reason: `no ready setup of ${key} (${hint})` }
}

/**
 * Why: readiness must answer for the runtime status read and for this route's host; otherwise the
 * runtime restarted mid-read or the setup resolves elsewhere, and its preview is not this route's.
 */
function readinessMismatch(facts: LaunchCandidateFacts): string | null {
  const answer = facts.readiness?.ok ? facts.readiness.result : null
  if (!answer || !facts.status.ok) {
    return null
  }
  if (answer.runtimeId !== facts.status.runtimeId) {
    return 'restarted while it was being read (unverifiable)'
  }
  const { route } = facts
  const expected = route.kind === 'ssh' ? toSshExecutionHostId(route.targetId) : 'local'
  return answer.workspace.hostId === expected
    ? null
    : `its setup resolves to ${answer.workspace.hostId}, not this route (unverifiable)`
}

function verdictFor(
  candidate: Omit<LaunchCandidate, 'state' | 'reason'>,
  facts: LaunchCandidateFacts,
  gaps: SetupGaps
): Verdict {
  const { status, project } = facts
  if (!status.ok) {
    return { state: 'unverifiable', reason: status.reason }
  }
  if (!candidate.launchCapability) {
    const version = `OmniConsole ${status.appVersion ?? '(version unknown)'}`
    return {
      state: 'old-runtime',
      reason: `${candidate.route.kind === 'ssh' ? `this computer's ${version}` : version}: ${LAUNCH_OLD_RUNTIME_NOTE}`
    }
  }
  if (!facts.setups.ok) {
    return {
      state: facts.setups.unsupported ? 'no-setup' : 'unverifiable',
      reason: facts.setups.reason
    }
  }
  if (!candidate.setup) {
    return noSetupVerdict(candidate, project, gaps)
  }
  if (facts.readiness && !facts.readiness.ok) {
    return { state: 'unverifiable', reason: facts.readiness.reason }
  }
  const mismatch = readinessMismatch(facts)
  if (mismatch) {
    return { state: 'unverifiable', reason: mismatch }
  }
  if (project && candidate.setup.kind === 'git' && !candidate.idempotentCreate) {
    return {
      state: 'no-idempotent-create',
      reason: `cannot create the launch worktree idempotently (no ${WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY})`
    }
  }
  if (!candidate.account?.verified) {
    return {
      state: 'unverified-account',
      reason: unverifiedReason(candidate.account, facts.provider)
    }
  }
  if (candidate.load?.band === 'hot') {
    return { state: 'hot', reason: `${candidate.load.loadPerCore.toFixed(2)} load per core (hot)` }
  }
  const { receipt } = candidate.account
  return {
    state: 'fresh',
    reason: `${receipt.remainingPercent}% left on ${receipt.label}${candidate.load ? '' : '; load unknown'}`
  }
}

/** One candidate from its reads; absent or failed reads are unverifiable, never idle or 0%. */
export function classifyLaunchCandidate(facts: LaunchCandidateFacts): LaunchCandidate {
  const { route, project, status } = facts
  const ssh = route.kind === 'ssh'
  const capabilities = status.ok ? status.capabilities : []
  const listed = facts.setups.ok
    ? launchRouteSetups(facts.setups.setups, route)
    : { own: [], nested: [] }
  // Why: a `repo:` id is one computer's own repo id; only setups this computer registered match it.
  const visible =
    !project || route.kind !== 'environment' || !isHostLocalProjectId(project.identityKey)
  const matches = (setup: ProjectHostSetup): boolean =>
    visible && (!project || setup.projectId === project.identityKey)
  const own = listed.own.filter(matches)
  const usable = own.filter(hasRepoRecord)
  // Why: an answer for another runtime or host is not this route's; none of its fields describe it.
  const readiness =
    facts.readiness?.ok && readinessMismatch(facts) === null ? facts.readiness.result : null
  const candidate: Omit<LaunchCandidate, 'state' | 'reason'> = {
    // Why not status for SSH: that is this computer's id, not the SSH host's.
    machineId: readiness?.machineId ?? (!ssh && status.ok ? status.sessionHostId : null),
    label: facts.label,
    route,
    isThisComputer: facts.isThisComputer,
    appVersion: !ssh && status.ok ? status.appVersion : null,
    launchCapability: capabilities.includes(
      AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY
    ),
    idempotentCreate: capabilities.includes(WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY),
    reachable: status.ok && !(facts.readiness?.ok === false && facts.readiness.unreachable),
    checkedAt: facts.checkedAt,
    runtimeId: status.ok ? status.runtimeId : null,
    hostId: readiness?.workspace.hostId ?? null,
    setup: chooseLaunchSetup(usable),
    setupCount: own.length,
    account: readiness?.account ?? null,
    // Why: os.loadavg() is always 0 on Windows, so a Windows runtime's load is unknown, never idle.
    load: !ssh && status.ok && status.hostPlatform === 'win32' ? null : (readiness?.load ?? null)
  }
  const gaps = {
    nested: listed.nested.filter(matches).length,
    unrecorded: own.length - usable.length
  }
  return { ...candidate, ...verdictFor(candidate, facts, gaps) }
}
