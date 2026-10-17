/**
 * This computer's switches as an execution host (Phase 4). Every one is on by default (Sal,
 * 25 Sep); each is an emergency off, and `OMNI_SESSION_HOST_DISABLED=1` in main's environment
 * stops remote control and host stewardship at once. The steward's own switches still apply.
 */

import {
  effectiveSessionHostFolderPolicy,
  SessionHostFolderPolicySchema,
  type SessionHostFolderPolicy
} from './session-host-sync-doc'

export type SessionHostControlSettings = {
  /** Other computers may carry out controls on the sessions this computer runs. */
  remoteControls: boolean
  /** Automatic callers (this host's steward, another computer's) may act on its sessions. */
  hostStewardship: boolean
  /** Reduce-only overrides by folder id: `automation: 'off'` admits no automation there. */
  folderPolicies: Record<string, SessionHostFolderPolicy>
  /**
   * Reduce-only switches this Mac set on other computers' hosts, by their registry host id; they
   * reach those computers through account sync and read pending until each confirms.
   */
  hostPolicies: Record<string, SessionHostFolderPolicy>
  /** Conversations may be moved to or from this computer, on a person's explicit request. */
  relocation: boolean
}

export const SESSION_HOST_CONTROL_DISABLED_ENV = 'OMNI_SESSION_HOST_DISABLED'

export function getDefaultSessionHostControlSettings(): SessionHostControlSettings {
  return {
    remoteControls: true,
    hostStewardship: true,
    folderPolicies: {},
    hostPolicies: {},
    relocation: true
  }
}

function normalizePolicies(raw: unknown): Record<string, SessionHostFolderPolicy> {
  const policies: Record<string, SessionHostFolderPolicy> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, policy] of Object.entries(raw)) {
      const parsed = SessionHostFolderPolicySchema.safeParse(policy)
      // Why off when unreadable: an override exists to reduce autonomy, so a bad one must not relax it.
      policies[key] = parsed.success
        ? effectiveSessionHostFolderPolicy(parsed.data)
        : { automation: 'off', relocation: 'off' }
    }
  }
  return policies
}

/** Persisted or hand-edited input: each switch is on unless explicitly off. */
export function normalizeSessionHostControlSettings(raw: unknown): SessionHostControlSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return getDefaultSessionHostControlSettings()
  }
  const value = raw as Record<string, unknown>
  return {
    remoteControls: value.remoteControls !== false,
    hostStewardship: value.hostStewardship !== false,
    folderPolicies: normalizePolicies(value.folderPolicies),
    hostPolicies: normalizePolicies(value.hostPolicies),
    relocation: value.relocation !== false
  }
}

/** Same reading as `OMNI_STEWARD_DISABLED`: set and not `0`/`false`. */
export function sessionHostControlDisabledByEnv(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const raw = env[SESSION_HOST_CONTROL_DISABLED_ENV]?.trim().toLowerCase()
  return Boolean(raw) && raw !== '0' && raw !== 'false'
}
