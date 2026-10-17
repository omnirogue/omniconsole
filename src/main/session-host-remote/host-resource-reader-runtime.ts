/**
 * The real reader: this Mac's own `collectHostMemory()` and registry, and each remote host through
 * the session host client the Work card already keeps (`RemoteSessionHosts.clientFor`).
 */

import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { collectHostMemory } from '../memory/host-memory'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { countLiveSessions, hostStatsMemory } from '../session-host/session-host-stats'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { getRemoteSessionHosts } from './remote-session-hosts-runtime'
import { HostResourceReader, type HostResourceAnswer } from './host-resource-reader'

let reader: HostResourceReader | null = null
/** Each remote host's `host.hostId` from its latest answer; placement dedupes routes by it. */
const machineIds = new Map<string, string>()

async function readLocal(): Promise<HostResourceAnswer> {
  // Why `current()`: reading resources must never open or create the registry.
  const service = activeRuntimeSessionHost()?.current() ?? null
  const [memory, liveSessions] = await Promise.all([
    collectHostMemory(),
    service ? countLiveSessions(service) : Promise.resolve(null)
  ])
  return { state: 'ok', memory: hostStatsMemory(memory), liveSessions }
}

async function askRemote(hostKey: string): Promise<HostResourceAnswer & { hostId?: string }> {
  const client = await getRemoteSessionHosts()?.clientFor(hostKey)
  if (!client) {
    return {
      state: 'unavailable',
      detail: 'This computer cannot reach that host right now.',
      memory: null,
      liveSessions: null
    }
  }
  const reply = await client.hostStats()
  if (reply.status !== 'ok') {
    return { state: 'unavailable', detail: reply.refusal.message, memory: null, liveSessions: null }
  }
  return {
    state: 'ok',
    memory: reply.memory,
    liveSessions: reply.liveSessions,
    hostId: reply.host.hostId
  }
}

async function readRemote(hostKey: string): Promise<HostResourceAnswer> {
  // Why forgotten on failure: an id from an earlier answer may no longer be that host's.
  const { hostId, ...answer } = await askRemote(hostKey).catch((error: unknown) => {
    machineIds.delete(hostKey)
    throw error
  })
  if (hostId) {
    machineIds.set(hostKey, hostId)
  } else {
    machineIds.delete(hostKey)
  }
  return answer
}

export function getHostResourceReader(): HostResourceReader {
  reader ??= new HostResourceReader({ readLocal, readRemote, now: Date.now })
  return reader
}

/** One per machine and OS user: this runtime's registry id, or what the host last answered. */
export function hostResourceMachineId(hostKey: string): string | null {
  if (hostKey === LOCAL_EXECUTION_HOST_ID) {
    return activeRuntimeSessionHost()?.current()?.identity.hostId ?? null
  }
  return machineIds.get(hostKey) ?? null
}

/**
 * The OS behind a host key, when known: this process's own, or the one the SSH relay detected at
 * its handshake (the signal the runtime already trusts for SSH pty writes). Null when unknown.
 */
export function hostResourcePlatform(hostKey: string): string | null {
  if (hostKey === LOCAL_EXECUTION_HOST_ID) {
    return process.platform
  }
  const host = parseExecutionHostId(hostKey)
  return host?.kind === 'ssh'
    ? (getRegisteredSshState(host.targetId)?.remotePlatform ?? null)
    : null
}
