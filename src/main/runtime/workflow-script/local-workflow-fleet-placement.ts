import os from 'node:os'
import {
  chooseWorkflowFleetHost,
  workflowFleetPlacementRefusal,
  workflowNamedHostHotRefusal,
  workflowNamedHostRefusal,
  workflowPlacementCapacityText,
  workflowRemoteRuntimeRefusal,
  WORKFLOW_FLEET_NAMED_MAX_LOAD_PER_CORE,
  type WorkflowPlacement,
  type WorkflowPlacementPick,
  type WorkflowRunsOn
} from '../../../shared/local-workflow-placement'
import {
  isLocalWorkflowFleetHost,
  probeWorkflowFleetRuntime,
  readWorkflowFleetCapacity,
  readWorkflowFleetHosts,
  shortWorkflowHostname,
  workflowFleetHostsFilePath,
  type WorkflowFleetCandidate,
  type WorkflowFleetPlacementDeps
} from './local-workflow-fleet-hosts'

export type { WorkflowFleetPlacementDeps } from './local-workflow-fleet-hosts'

/** A fleet Start refused with its decided placement, so the refusal can be recorded. */
export class WorkflowFleetPlacementRefusal extends Error {
  constructor(
    message: string,
    readonly placement?: WorkflowPlacement
  ) {
    super(message)
    this.name = 'WorkflowFleetPlacementRefusal'
  }
}

function sameHostName(value: string | null, name: string): boolean {
  return !!value && shortWorkflowHostname(value) === shortWorkflowHostname(name)
}

/** The frozen host facts of a candidate with a fresh reading. */
function placedHost(candidate: WorkflowFleetCandidate & { capacity: { state: 'fresh' } }) {
  return {
    name: candidate.name,
    machine: candidate.machine,
    cores: candidate.cores,
    loadPerCore: candidate.capacity.loadPerCore,
    readAt: candidate.capacity.readAt,
    ...(candidate.local || !candidate.ssh ? {} : { ssh: candidate.ssh })
  }
}

/**
 * A host this computer does not run on: probed for a runtime with account services. One with
 * them is `remote-runtime`, which this build cannot hand a run to, so it is refused by name; one
 * without runs as `dispatched-seats`, the seats and the Check dispatched to it over SSH.
 */
async function placeRemote(
  chosen: WorkflowFleetCandidate & { capacity: { state: 'fresh' } },
  placement: Omit<WorkflowPlacement, 'mode'>,
  deps: WorkflowFleetPlacementDeps
): Promise<WorkflowPlacement> {
  if (await probeWorkflowFleetRuntime(chosen, deps)) {
    throw new WorkflowFleetPlacementRefusal(workflowRemoteRuntimeRefusal(chosen.name), {
      ...placement,
      mode: 'remote-runtime'
    })
  }
  return { ...placement, mode: 'dispatched-seats' }
}

/**
 * A host picked by name ("Run on: <host>", `--host`): it must be a heavy-work row of the hosts
 * file and answer a fresh reading now. Up to the 0.8 bound it takes the run even without spare
 * capacity; above it only a person's forced reason lets it (callers refuse agents first).
 */
async function placeNamed(
  pick: WorkflowPlacementPick,
  path: string,
  deps: WorkflowFleetPlacementDeps
): Promise<WorkflowPlacement> {
  const hosts = await readWorkflowFleetHosts(path)
  const row = hosts.find((host) =>
    [host.name, host.machine, host.hostname, host.ssh].some((value) =>
      sameHostName(value, pick.host)
    )
  )
  if (!row) {
    const known = hosts.filter((host) => host.heavyOk).map((host) => host.name)
    throw new WorkflowFleetPlacementRefusal(
      `No fleet host is named ${pick.host} in ${path}${known.length ? ` (heavy-work hosts: ${known.join(', ')})` : ''}.`
    )
  }
  if (!row.heavyOk) {
    throw new WorkflowFleetPlacementRefusal(
      workflowNamedHostRefusal(row.name, 'not a heavy-work host')
    )
  }
  const [candidate] = await readWorkflowFleetCapacity([row], deps)
  const now = deps.now?.() ?? Date.now()
  if (!candidate || candidate.capacity.state !== 'fresh') {
    throw new WorkflowFleetPlacementRefusal(
      workflowNamedHostRefusal(
        row.name,
        candidate ? workflowPlacementCapacityText(candidate, now) : 'unknown'
      )
    )
  }
  const fresh = candidate as WorkflowFleetCandidate & { capacity: { state: 'fresh' } }
  const forced = pick.forceReason?.trim()
  if (fresh.capacity.loadPerCore > WORKFLOW_FLEET_NAMED_MAX_LOAD_PER_CORE && !forced) {
    throw new WorkflowFleetPlacementRefusal(
      workflowNamedHostHotRefusal(row.name, fresh.capacity.loadPerCore)
    )
  }
  const placement = {
    runsOn: 'fleet' as const,
    host: placedHost(fresh),
    choice: 'named' as const,
    ...(pick.hostId ? { hostId: pick.hostId } : {}),
    ...(forced && fresh.capacity.loadPerCore > WORKFLOW_FLEET_NAMED_MAX_LOAD_PER_CORE
      ? { forced }
      : {})
  }
  return fresh.local ? { ...placement, mode: 'local' } : await placeRemote(fresh, placement, deps)
}

/**
 * Where a Start runs. 'local' runs here without a reading. A named host (`pick`) is read and
 * taken as named, or refused by name. Otherwise the fleet (the default) reads every heavy-work
 * host, tries hosts in verified spare-capacity order, and refuses with every host named
 * when none verifies. A choice that is this computer runs here as `mode: local`; any other host
 * runs as `dispatched-seats`, or is refused as `remote-runtime` (placeRemote). Discover admission falls back here only after the fleet is exhausted.
 */
export async function placeLocalWorkflow(
  runsOn: WorkflowRunsOn | undefined,
  deps: WorkflowFleetPlacementDeps = {},
  pick?: WorkflowPlacementPick,
  excludedMachines: readonly string[] = []
): Promise<WorkflowPlacement> {
  const path = deps.hostsFile ?? workflowFleetHostsFilePath()
  if (pick) {
    if (runsOn === 'local') {
      throw new WorkflowFleetPlacementRefusal(
        `Choose either 'this computer' or a host to run on, not both (${pick.host}).`
      )
    }
    return await placeNamed(pick, path, deps)
  }
  if (runsOn === 'local') {
    return { runsOn: 'local', mode: 'local' }
  }
  const candidates = await readWorkflowFleetCapacity(await readWorkflowFleetHosts(path), deps)
  const now = deps.now?.() ?? Date.now()
  const remaining = candidates.filter((candidate) => !excludedMachines.includes(candidate.machine))
  const failures: string[] = []
  for (;;) {
    const chosen = chooseWorkflowFleetHost(remaining, now)
    if (!chosen || chosen.capacity.state !== 'fresh') {
      throw new WorkflowFleetPlacementRefusal(
        failures.length
          ? failures.join(' ')
          : workflowFleetPlacementRefusal(remaining, now, `no fleet hosts in ${path}`)
      )
    }
    remaining.splice(remaining.indexOf(chosen), 1)
    const fresh = chosen as WorkflowFleetCandidate & { capacity: { state: 'fresh' } }
    const placement = { runsOn: 'fleet' as const, host: placedHost(fresh) }
    try {
      return fresh.local
        ? { ...placement, mode: 'local' }
        : await placeRemote(fresh, placement, deps)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * One host the setup forms offer as "Run on: <host>": a heavy-work row of the hosts file. `ssh`
 * is the alias placement reaches it by, so a form can name the matching SSH target it picked.
 */
export type WorkflowFleetHostOption = {
  name: string
  machine: string
  hostname: string
  ssh: string | null
  local: boolean
}

/** The heavy-work hosts a person may name; no reading is taken until a Start. */
export async function listWorkflowFleetHostOptions(
  deps: Pick<WorkflowFleetPlacementDeps, 'hostsFile' | 'local'> = {}
): Promise<{ path: string; hosts: WorkflowFleetHostOption[] }> {
  const path = deps.hostsFile ?? workflowFleetHostsFilePath()
  const hostname = deps.local?.hostname ?? os.hostname()
  const hosts = (await readWorkflowFleetHosts(path))
    .filter((host) => host.heavyOk)
    .map((host) => ({
      name: host.name,
      machine: host.machine,
      hostname: host.hostname,
      ssh: host.ssh,
      local: isLocalWorkflowFleetHost(host, hostname)
    }))
  return { path, hosts }
}
