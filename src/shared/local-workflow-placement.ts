/**
 * Where a workflow runs: the fleet (a registered worker with verified spare capacity, the
 * default for every preset) or this computer, an explicit opt-in. The host decides at admission
 * and freezes the decision into the run's snapshot (docs/reference/workflow-fleet-placement.md).
 */
export type WorkflowRunsOn = 'fleet' | 'local'
/** What every preset and every client sends when the person has not chosen. */
export const WORKFLOW_DEFAULT_RUNS_ON: WorkflowRunsOn = 'fleet'

/** The 60 percent rule: 1-minute load divided by cores under this is spare capacity. */
export const WORKFLOW_FLEET_SPARE_LOAD_PER_CORE = 0.6
/** A host picked by name is refused above this, unless a person forces it with a reason. */
export const WORKFLOW_FLEET_NAMED_MAX_LOAD_PER_CORE = 0.8
/** A capacity reading older than this is stale; the reader takes one per Start, so none should be. */
export const WORKFLOW_FLEET_READING_FRESH_MS = 60_000

/**
 * A fleet host's capacity as the host last read it. Only `fresh` under the spare-load bound is
 * verified capacity: `stale` (an old reading), `unknown` (no reading), `saturated` (a reading
 * with no number, known busy) and `unreachable` (the reading failed) never are.
 */
export type WorkflowPlacementCapacity =
  | { state: 'fresh'; loadPerCore: number; readAt: number }
  | { state: 'stale' | 'unknown' | 'saturated' | 'unreachable' }

export type WorkflowPlacementCandidate = {
  name: string
  /** Dedupes capacity: two SSH aliases into one box are one pool of cores. */
  machine: string
  ssh: string | null
  cores: number
  heavyOk: boolean
  capacity: WorkflowPlacementCapacity
}

/**
 * How a fleet run reaches its host: `local` runs here; `remote-runtime` hands the run to an
 * OmniConsole runtime with account services on the host; `dispatched-seats` runs seats and the
 * Check on the host's checkout while the controller stays on this computer.
 */
export type WorkflowPlacementMode = 'local' | 'remote-runtime' | 'dispatched-seats'

export type WorkflowPlacementHost = {
  name: string
  machine: string
  cores: number
  loadPerCore: number
  readAt: number
  /** The SSH alias the reading went over and dispatched seats reach the host by; absent here. */
  ssh?: string
}

/**
 * Where dispatched seats run on the host: a private folder per run under the host's home, and
 * the frozen copy of what the agents may read when the run reads files.
 */
export type WorkflowPlacementDispatch = {
  /** Absolute path of the run's folder on the host. */
  root: string
  /** The host account's resolved home, where its CLIs keep their logins. */
  home: string
  /** Paths a Codex seat is denied on the host (its home and data outside it). */
  hidden: string[]
  /** The frozen copy of what agents read, for runs that read files; `digest` is its archive's sha256. */
  workspace?: { path: string; files: number; bytes: number; digest: string }
}

/** Frozen into the snapshot at admission; a replay never re-reads the fleet. */
export type WorkflowPlacement = {
  runsOn: WorkflowRunsOn
  host?: WorkflowPlacementHost
  mode: WorkflowPlacementMode
  /** `named`: a person or agent picked the host ("Run on: <host>", `--host`); absent: auto. */
  choice?: 'named'
  /** The execution host id picked in the form (`ssh:<target-id>` or `local`), when it had one. */
  hostId?: string
  /** A person's reason for running on a named host above the 0.8 bound. */
  forced?: string
  /**
   * Why a Discover asked for the fleet runs on this computer instead: the fleet's refusal, word
   * for word (Sal, 2026-10-14: "Run it on this Mac instead"). Absent on every other run.
   */
  fallback?: string
  dispatch?: WorkflowPlacementDispatch
}

/** An explicit host for a Start: by name, optionally forced past the load bound by a person. */
export type WorkflowPlacementPick = {
  host: string
  hostId?: string
  forceReason?: string
}

function verifiedLoad(candidate: WorkflowPlacementCandidate, now: number): number | undefined {
  const { capacity } = candidate
  return candidate.heavyOk &&
    capacity.state === 'fresh' &&
    now - capacity.readAt <= WORKFLOW_FLEET_READING_FRESH_MS &&
    capacity.loadPerCore < WORKFLOW_FLEET_SPARE_LOAD_PER_CORE
    ? capacity.loadPerCore
    : undefined
}

/**
 * The fleet host a run defaults to, mirroring chooseWorkflowRouteAccount: only a heavy-ok host
 * with a fresh reading under the spare-load bound is verified capacity, the most spare (lowest
 * load per core) wins, ties by name. With nothing verified there is no host: a fleet run is
 * then refused, never run here.
 */
export function chooseWorkflowFleetHost<T extends WorkflowPlacementCandidate>(
  candidates: readonly T[],
  now = Date.now()
): T | undefined {
  return candidates
    .flatMap((candidate) => {
      const load = verifiedLoad(candidate, now)
      return load === undefined ? [] : [{ candidate, load }]
    })
    .sort((a, b) => a.load - b.load || a.candidate.name.localeCompare(b.candidate.name))[0]
    ?.candidate
}

/** One host's reading, for the refusal that names every host it looked at. */
export function workflowPlacementCapacityText(
  candidate: WorkflowPlacementCandidate,
  now = Date.now()
): string {
  const { capacity } = candidate
  if (!candidate.heavyOk) {
    return 'not a heavy-work host'
  }
  if (capacity.state !== 'fresh') {
    return capacity.state
  }
  if (now - capacity.readAt > WORKFLOW_FLEET_READING_FRESH_MS) {
    return 'stale'
  }
  return `${capacity.loadPerCore.toFixed(2)} load per core`
}

/** Why no fleet host takes the run, naming each host looked at; `empty` when none was. */
export function workflowFleetPlacementRefusal(
  candidates: readonly WorkflowPlacementCandidate[],
  now = Date.now(),
  empty = 'no fleet hosts are registered'
): string {
  const looked = candidates.length
    ? candidates
        .map((candidate) => `${candidate.name}: ${workflowPlacementCapacityText(candidate, now)}`)
        .join(', ')
    : empty
  return `No fleet host has verified spare capacity (${looked}). Choose 'this computer' to run here.`
}

/** Why Build + Review cannot dispatch its workers: they edit this workspace's own files. */
export function buildReviewDispatchedSeatsRefusal(hostName: string): string {
  return `Build + Review workers edit this workspace's files, so they cannot run as dispatched seats on ${hostName} in this build. Choose 'this computer' to run here.`
}

/** Why a host picked by name does not take the run; `reading` is the host's capacity text. */
export function workflowNamedHostRefusal(hostName: string, reading: string): string {
  return `${hostName} cannot take this run (${reading}). Choose another host, the fleet, or 'this computer'.`
}

/** A named host above the bound: a person may force it with a reason, an agent never. */
export function workflowNamedHostHotRefusal(hostName: string, loadPerCore: number): string {
  return `${hostName} is too busy for this run (${loadPerCore.toFixed(2)} load per core, over ${WORKFLOW_FLEET_NAMED_MAX_LOAD_PER_CORE}). Choose another host, or force it with a reason.`
}

/** `--force-host` from an agent: overriding the load bound is a person's call. */
export const WORKFLOW_AGENT_FORCE_HOST_REFUSAL =
  'Only a person can force a busy host; an agent cannot use --force-host.'

/** One line naming where a run was placed and the reading it was placed on. */
export function workflowPlacementSummary(placement: WorkflowPlacement): string {
  if (!placement.host) {
    return 'this computer (chosen explicitly)'
  }
  const reading = `${placement.host.loadPerCore.toFixed(2)} load per core at ${new Date(placement.host.readAt).toISOString()}`
  const how = placement.choice === 'named' ? 'named' : 'most spare capacity'
  const mode = placement.mode === 'local' ? 'this computer' : placement.mode
  return `${placement.host.name} (${mode}, ${how}, ${reading}${placement.forced ? `, forced: ${placement.forced}` : ''})`
}

/** Why this build cannot hand a run to a fleet host's runtime, although it has account services. */
export function workflowRemoteRuntimeRefusal(hostName: string): string {
  return `${hostName} runs an OmniConsole runtime with account services, but this build cannot hand a workflow to it yet. Choose 'this computer' to run here.`
}
