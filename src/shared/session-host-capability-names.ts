// The Phase 4 capability names on their own, with no imports, so `protocol-version.ts` can list
// them in a client declaration without an import cycle. `session-host-capabilities.ts` re-exports
// them; read that module for their meaning.

export const SESSION_CONTROL_OWNER_CAPABILITY = 'session-control.owner.v1' as const
export const SESSION_ORGANIZATION_HOST_CAPABILITY = 'session-organization.host.v1' as const
export const SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY =
  'session-transfer.remote-source.v1' as const
export const SESSION_RELOCATION_CLAUDE_CAPABILITY = 'session-relocation.claude.v1' as const
export const SESSION_RELOCATION_CODEX_CAPABILITY = 'session-relocation.codex.v1' as const
/** Moving a relocation's files between computers; offered only beside a provider's relocation. */
export const SESSION_RELOCATION_BUNDLE_CAPABILITY = 'session-relocation.bundle.v1' as const
export const SESSION_WAITS_REMOTE_CAPABILITY = 'session-waits.remote.v1' as const
/** A Mac's own automatic writers deliver through the execution host's admission (package B2). */
export const SESSION_CONTROL_DELIVERY_CAPABILITY = 'session-control.delivery.v1' as const
/** `sessionHost.hostStats`: the host's free memory, load and live session count (read-only). */
export const SESSION_HOST_STATS_CAPABILITY = 'session-control.host-stats.v1' as const

export const SESSION_HOST_CAPABILITIES = [
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  SESSION_RELOCATION_CLAUDE_CAPABILITY,
  SESSION_RELOCATION_CODEX_CAPABILITY,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY,
  SESSION_CONTROL_DELIVERY_CAPABILITY,
  SESSION_HOST_STATS_CAPABILITY
] as const
export type SessionHostCapability = (typeof SESSION_HOST_CAPABILITIES)[number]

/** What a client that implements every surface declares (`remoteRuntimeClientCapabilities(...)`). */
export const SESSION_HOST_CLIENT_CAPABILITIES: readonly SessionHostCapability[] =
  SESSION_HOST_CAPABILITIES
