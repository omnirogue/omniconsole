// Where the RPC layer finds the host.
//
// The runtime service is already far past its size budget, so structured
// sessions hang off a module-level slot instead of another field on it — the
// same shape the native-chat RPC methods use to reach their own collaborators.
// Tests install a host with a stub adapter and clear it on teardown.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

let host: StructuredAgentSessionHost | null = null
const hostListeners = new Set<(next: StructuredAgentSessionHost | null) => void>()

export function setStructuredAgentSessionHost(next: StructuredAgentSessionHost | null): void {
  if (host === next) {
    return
  }
  host = next
  for (const listener of hostListeners) {
    try {
      listener(next)
    } catch (error) {
      console.error('[structured-agent-session] host listener threw', error)
    }
  }
}

/** Follows the slot: the host installs asynchronously and is cleared on stop. */
export function subscribeStructuredAgentSessionHost(
  listener: (next: StructuredAgentSessionHost | null) => void
): () => void {
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}

export function getStructuredAgentSessionHost(): StructuredAgentSessionHost | null {
  return host
}
