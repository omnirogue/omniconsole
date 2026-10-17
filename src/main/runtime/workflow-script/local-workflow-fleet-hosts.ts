import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import type { WorkflowPlacementCandidate } from '../../../shared/local-workflow-placement'

/** Overrides the estate hosts file (docs/reference/workflow-fleet-placement.md). */
export const WORKFLOW_FLEET_HOSTS_FILE_ENV = 'OMNI_ESTATE_HOSTS_FILE'
/** Every reading runs in parallel and the probe once, each within this bound. */
export const WORKFLOW_FLEET_READ_TIMEOUT_MS = 5_000
/** One line for macOS and Linux: the core count, then the load averages. */
export const WORKFLOW_FLEET_LOAD_COMMAND =
  'sysctl -n hw.ncpu vm.loadavg 2>/dev/null || { nproc; cat /proc/loadavg; }'
/** Prints the CLI envelope of that host's `accounts.list`; `ok: true` only with account services. */
export const WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND = 'omni account list --json'
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3'] as const

/** The one SSH invocation every fleet reading, probe and dispatched seat uses: key auth, no prompt. */
export function workflowFleetSshArgs(alias: string, command: string): string[] {
  // An alias that reads as an option (`-oProxyCommand=…`) would run a command here.
  if (!/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/.test(alias)) {
    throw new Error(`The fleet host alias ${JSON.stringify(alias)} is not a plain SSH host name.`)
  }
  return [...SSH_OPTIONS, alias, command]
}

/** One row of the estate hosts file that a workflow may run on. */
export type WorkflowFleetHost = {
  name: string
  machine: string
  hostname: string
  ssh: string | null
  heavyOk: boolean
}

/** A candidate with its reading, and whether it is the computer this host runs on. */
export type WorkflowFleetCandidate = WorkflowPlacementCandidate & { local: boolean }

export type WorkflowFleetPlacementDeps = {
  hostsFile?: string
  run?: (spec: ProcessSpec) => Promise<ProcessResult>
  /** This computer's own facts; tests replace them. `load1` is absent where the OS keeps no load average. */
  local?: { hostname: string; cores: number; load1?: number }
  now?: () => number
  timeoutMs?: number
}

export function workflowFleetHostsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): string {
  return (
    env[WORKFLOW_FLEET_HOSTS_FILE_ENV] ||
    join(home, 'Work', 'Ops', 'autonomy', 'canonical', 'hosts.json')
  )
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The file's `hosts[]`; a missing file is no hosts, an unreadable one names itself. */
export async function readWorkflowFleetHosts(path: string): Promise<WorkflowFleetHost[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new Error(`The fleet hosts file ${path} could not be read.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`The fleet hosts file ${path} is not JSON.`)
  }
  const rows =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { hosts?: unknown }).hosts)
      ? ((parsed as { hosts: unknown[] }).hosts as unknown[])
      : []
  const seen = new Set<string>()
  const hosts: WorkflowFleetHost[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const entry = row as Record<string, unknown>
    const name = text(entry.name)
    if (!name) {
      continue
    }
    const machine = text(entry.machine) ?? name
    // One box under two aliases is one pool of cores; the first row names it.
    if (seen.has(machine)) {
      continue
    }
    seen.add(machine)
    hosts.push({
      name,
      machine,
      hostname: text(entry.hostname) ?? name,
      ssh: text(entry.ssh) ?? null,
      heavyOk: entry.heavy_ok === true
    })
  }
  return hosts
}

/** A host name compared case-insensitively, with or without `.local`. */
export function shortWorkflowHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.local$/, '')
}

/** Whether a hosts-file row names the computer this process runs on. */
export function isLocalWorkflowFleetHost(host: WorkflowFleetHost, localHostname: string): boolean {
  const local = shortWorkflowHostname(localHostname)
  return [host.hostname, host.machine, host.name].some(
    (value) => shortWorkflowHostname(value) === local
  )
}

// Exactly the shapes the load command prints: `{ 1m 5m 15m }` on macOS, `/proc/loadavg` on Linux.
const MACOS_LOADAVG = /^\{\s*(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*\}$/
const LINUX_LOADAVG = /^(\d+(?:\.\d+)?)\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+\/\d+\s+\d+$/

/**
 * Cores and the 1-minute load from WORKFLOW_FLEET_LOAD_COMMAND's output on either OS. Anything
 * but those two lines in their exact shape is no reading: a number inside a banner or an error
 * message must never become verified capacity.
 */
export function parseWorkflowFleetLoad(
  stdout: string
): { cores: number; load1: number } | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length !== 2 || !/^\d+$/.test(lines[0]!)) {
    return undefined
  }
  const cores = Number.parseInt(lines[0]!, 10)
  const load = MACOS_LOADAVG.exec(lines[1]!) ?? LINUX_LOADAVG.exec(lines[1]!)
  const load1 = Number.parseFloat(load?.[1] ?? '')
  // A digit string too long for a safe integer parses to Infinity, and a load over Infinity is 0.
  return Number.isSafeInteger(cores) && cores > 0 && Number.isFinite(load1)
    ? { cores, load1 }
    : undefined
}

async function sshRun(
  deps: WorkflowFleetPlacementDeps,
  alias: string,
  command: string
): Promise<ProcessResult | undefined> {
  try {
    return await (deps.run ?? runProcess)({
      program: 'ssh',
      args: workflowFleetSshArgs(alias, command),
      timeoutMs: deps.timeoutMs ?? WORKFLOW_FLEET_READ_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024
    })
  } catch {
    return undefined
  }
}

function localFacts(deps: WorkflowFleetPlacementDeps) {
  if (deps.local) {
    return deps.local
  }
  // Windows keeps no load average (`os.loadavg()` is zeros there), and zero must never read as idle.
  const load1 = process.platform === 'win32' ? undefined : os.loadavg()[0]
  return { hostname: os.hostname(), cores: os.cpus().length, load1 }
}

/**
 * One fresh reading per heavy-work host, all in parallel and each bounded: this computer from
 * its own load average (`unknown` where the OS keeps none), every other host over SSH. A
 * reading that fails, times out or does not parse leaves the host `unreachable`, never a guess
 * and never `exited`.
 */
export async function readWorkflowFleetCapacity(
  hosts: readonly WorkflowFleetHost[],
  deps: WorkflowFleetPlacementDeps = {}
): Promise<WorkflowFleetCandidate[]> {
  const local = localFacts(deps)
  const now = deps.now?.() ?? Date.now()
  return await Promise.all(
    hosts
      .filter((host) => host.heavyOk)
      .map(async (host): Promise<WorkflowFleetCandidate> => {
        const base = { name: host.name, machine: host.machine, ssh: host.ssh, heavyOk: true }
        if (isLocalWorkflowFleetHost(host, local.hostname)) {
          return {
            ...base,
            local: true,
            cores: local.cores,
            capacity:
              local.load1 === undefined
                ? { state: 'unknown' }
                : { state: 'fresh', loadPerCore: local.load1 / local.cores, readAt: now }
          }
        }
        const result = host.ssh
          ? await sshRun(deps, host.ssh, WORKFLOW_FLEET_LOAD_COMMAND)
          : undefined
        const reading =
          result && result.code === 0 && !result.timedOut
            ? parseWorkflowFleetLoad(result.stdout)
            : undefined
        return reading
          ? {
              ...base,
              local: false,
              cores: reading.cores,
              capacity: { state: 'fresh', loadPerCore: reading.load1 / reading.cores, readAt: now }
            }
          : { ...base, local: false, cores: 0, capacity: { state: 'unreachable' } }
      })
  )
}

/**
 * Whether the probe's stdout is the CLI's success envelope for `accounts.list`,
 * `{ id, ok: true, result: { claude, codex, rateLimits }, _meta }` (src/cli/format.ts). A runtime
 * without account services answers `{ ok: false, error }` and exits 1; a bare snapshot, a banner
 * or anything else is not a runtime with account services.
 */
export function parseWorkflowFleetRuntimeProbe(stdout: string): boolean {
  let envelope: unknown
  try {
    envelope = JSON.parse(stdout)
  } catch {
    return false
  }
  if (!envelope || typeof envelope !== 'object') {
    return false
  }
  const { ok, result } = envelope as { ok?: unknown; result?: unknown }
  return (
    ok === true && !!result && typeof result === 'object' && 'claude' in result && 'codex' in result
  )
}

/** Whether the host's own OmniConsole runtime answers an accounts snapshot over SSH. */
export async function probeWorkflowFleetRuntime(
  host: Pick<WorkflowFleetCandidate, 'ssh'>,
  deps: WorkflowFleetPlacementDeps = {}
): Promise<boolean> {
  const result = host.ssh
    ? await sshRun(deps, host.ssh, WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND)
    : undefined
  return !!result && result.code === 0 && !result.timedOut
    ? parseWorkflowFleetRuntimeProbe(result.stdout)
    : false
}
