/**
 * Placement's reading of the computer a launch would run on: its load band through the same
 * HostResourceReader the Computers list uses (`readLocal` for `local`, `sessionHost.hostStats` for
 * `ssh:`), plus its session host id for dedupe. Bounded; anything unread is unknown, never idle.
 */

import {
  agentLaunchLoadFromReading,
  type AgentLaunchHostId,
  type AgentLaunchLoad
} from '../../shared/agent-launch-account'
import type { HostResourceReading } from '../../shared/host-resource-model'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import {
  getHostResourceReader,
  hostResourceMachineId,
  hostResourcePlatform
} from '../session-host-remote/host-resource-reader-runtime'

/** Readiness never waits longer; the reader keeps reading a slow host in the background. */
export const AGENT_LAUNCH_LOAD_WAIT_MS = 4_000
/** The reader keeps a host's last answer while a slow re-read runs, so an old one is unknown. */
export const AGENT_LAUNCH_LOAD_MAX_AGE_MS = 60_000

export type AgentLaunchLoadSource = {
  read: (hostKey: string) => Promise<HostResourceReading | undefined>
  machineId: (hostKey: string) => string | null
  now: () => number
  /**
   * The OS of the computer behind the host key, or null when unknown: Windows keeps no load
   * average (`os.loadavg()` is zeros there, and `sessionHost.hostStats` carries no platform).
   */
  hostPlatform: (hostKey: string) => string | null
  waitMs?: number
}

export type AgentLaunchLoadReport = {
  load: AgentLaunchLoad | null
  machineId: string | null
}

export async function readAgentLaunchLoad(
  source: AgentLaunchLoadSource,
  hostId: AgentLaunchHostId
): Promise<AgentLaunchLoadReport> {
  const platform = source.hostPlatform(hostId)
  // Why before reading: this computer's zero on Windows is unread, and zero must never read as idle.
  if (hostId === 'local' && platform === 'win32') {
    return { load: null, machineId: source.machineId(hostId) }
  }
  const reading = await withTimeout(
    Promise.resolve().then(() => source.read(hostId)),
    source.waitMs ?? AGENT_LAUNCH_LOAD_WAIT_MS,
    undefined
  )
  const now = source.now()
  const recent =
    reading?.readAt != null && now - reading.readAt <= AGENT_LAUNCH_LOAD_MAX_AGE_MS ? reading : null
  const usable = agentLaunchLoadFromReading(recent, now)
  // Why: a Windows SSH host answers hostStats with a load average of 0. With its OS unknown, a
  // zero cannot be told from Windows' zero, so it is unknown too: ranked lower, never as idle.
  const unread = platform === 'win32' || (platform === null && recent?.memory?.loadAverage1m === 0)
  // Why an SSH id only beside a usable reading: an id kept from an old answer could merge machines.
  const machineId = hostId === 'local' || usable ? source.machineId(hostId) : null
  return { load: unread ? null : usable, machineId }
}

/** The runtime's real source: the process's one reader, shared with the Computers list. */
export function readRuntimeAgentLaunchLoad(
  hostId: AgentLaunchHostId
): Promise<AgentLaunchLoadReport> {
  return readAgentLaunchLoad(
    {
      read: async (hostKey) => (await getHostResourceReader().read([hostKey]))[0],
      machineId: hostResourceMachineId,
      now: Date.now,
      hostPlatform: hostResourcePlatform
    },
    hostId
  )
}
