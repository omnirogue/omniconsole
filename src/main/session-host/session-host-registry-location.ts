/**
 * Where an execution account's ownership registry lives. One per machine and OS user, shared by
 * every OmniConsole runtime profile and every relay version on it: the home directory holds it (a
 * profile directory or a relay install would split it), keyed by the machine identity the relay's
 * hook installer already uses, because a home can be shared across SSH hosts.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readManagedHookHostIdentity } from '../agent-hooks/managed-hook-owner-identity'
import { sessionHostDigest } from '../../shared/session-host-identity'

const SESSION_HOST_DIR = join('.omni', 'session-host')

export function sessionHostRegistryParent(home: string = homedir()): string {
  return join(home, SESSION_HOST_DIR)
}

/** Cheap and synchronous: no registry parent means no conversation was ever adopted here. */
export function sessionHostRegistryMayExist(home: string = homedir()): boolean {
  return existsSync(sessionHostRegistryParent(home))
}

/**
 * Null when the machine cannot identify itself durably: a per-process identity would give every
 * process its own registry, which is exactly the split ownership this registry exists to prevent.
 */
export async function readSessionHostMachineIdentity(): Promise<string | null> {
  const identity = await readManagedHookHostIdentity()
  return identity.startsWith('runtime:') ? null : identity
}

export function sessionHostRegistryRoot(machineIdentity: string, home: string = homedir()): string {
  const uid = process.getuid?.() ?? 'user'
  const key = sessionHostDigest(`${machineIdentity}\u0000${uid}`).slice('sha256:'.length, 39)
  return join(sessionHostRegistryParent(home), key)
}
