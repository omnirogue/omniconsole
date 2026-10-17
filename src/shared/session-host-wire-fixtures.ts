/**
 * Mixed-version fixtures for session host control (docs/reference/remote-wire-compatibility.md,
 * "Never write down what the old side has"). Pre-Phase-4 lists are DERIVED from this build's own
 * lists minus the session host family, so they stay exercised after it ships. Only the relay
 * answer is pinned: it is the shape of relay builds released before Phase 4 and never changes.
 */

import { RUNTIME_CAPABILITIES } from './protocol-version'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'
import {
  SESSION_HOST_CAPABILITIES,
  SESSION_HOST_CLIENT_CAPABILITIES,
  isSessionHostCapabilityFamily,
  type SessionHostCapability
} from './session-host-capabilities'
import type { SessionHostIdentity } from './session-host-identity'

export const FIXTURE_HOST: SessionHostIdentity = {
  hostId: 'host_c3ad3c23b1ff43a4b4687a6e9dbb6261',
  incarnation: '8ae165be-ce9e-4e28-9d0d-b0533c8b015b'
}
export const FIXTURE_OTHER_HOST_ID = 'host_f06cee505b3645bab00814b2f849e567'
export const FIXTURE_CONVERSATION_ID = 'conv_2437e543a0344939857f71286dd9b814'
export const FIXTURE_OTHER_CONVERSATION_ID = 'conv_cf7eff47949d43f2b75cc4ca8cb2a534'
export const FIXTURE_NOW = 1_790_337_600_000
export const fixtureOperationId = (n: number) =>
  `${FIXTURE_NOW + n}-${n.toString(16).padStart(8, '0')}67f27b9525294d6f9d98213c`

/** Pinned: `pty.getCapabilities` from every relay released before Phase 4. */
export const LEGACY_RELAY_PTY_CAPABILITIES = Object.freeze({
  acceptedInputVersion: 1,
  startupIngressVersion: 2,
  omniConsoleMcpDefaultVersion: 1,
  agentSessionClaimVersion: 2,
  agentSessionCreateOperationVersion: 1
})

const withoutFamily = (names: readonly string[]) =>
  names.filter((name) => !isSessionHostCapabilityFamily(name))

/** A relay with Phase 4: the legacy answer plus one optional field. */
export function phase4RelayPtyCapabilities(
  capabilities: readonly string[] = SESSION_HOST_CAPABILITIES,
  host: SessionHostIdentity = FIXTURE_HOST
) {
  return {
    ...LEGACY_RELAY_PTY_CAPABILITIES,
    sessionHost: { capabilities: [...capabilities], ...host }
  }
}

/** A paired runtime before Phase 4: this build's list without the session host family. */
export function legacyRuntimeStatus() {
  return { runtimeId: FIXTURE_HOST.incarnation, capabilities: withoutFamily(RUNTIME_CAPABILITIES) }
}

export function phase4RuntimeStatus(
  capabilities: readonly string[] = SESSION_HOST_CAPABILITIES,
  host: SessionHostIdentity = FIXTURE_HOST
) {
  return {
    runtimeId: host.incarnation,
    capabilities: [...withoutFamily(RUNTIME_CAPABILITIES), ...capabilities],
    sessionHost: host
  }
}

/** A client before Phase 4 declares this build's list without the family. */
export function legacyClientCapabilities(): string[] {
  return withoutFamily(remoteRuntimeClientCapabilities())
}

export function phase4ClientCapabilities(
  capabilities: readonly SessionHostCapability[] = SESSION_HOST_CLIENT_CAPABILITIES
): string[] {
  return remoteRuntimeClientCapabilities([...capabilities])
}
