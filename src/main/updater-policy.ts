// Why: no electron imports here — the app menu and tray import this module and their
// tests mock electron with only the pieces they use.
export type UpdaterDisabledReason = 'dev' | 'unpackaged' | 'local-build' | 'no-update-manifest'

export type UpdaterPolicy =
  | { updatesEnabled: true }
  | { updatesEnabled: false; reason: UpdaterDisabledReason; explanation: string }

export type UpdaterPolicyInput = {
  isPackaged: boolean
  isDev: boolean
  /** Whether electron-builder wrote app-update.yml next to the app; null when the
   *  resources directory is unknown (source launches, unit tests). */
  hasUpdateManifest: boolean | null
  /** `releaseBuild` from omni-local-build.json; null when the marker is absent or
   *  predates the field (builds made before this switch existed). */
  releaseBuild: boolean | null
}

export const LOCAL_BUILD_UPDATES_DISABLED_MESSAGE =
  'Local build — updates are disabled so this install is never replaced by a release build'

/**
 * Decides whether this install may check for and apply updates.
 *
 * Why: the update feed serves release builds. An ad-hoc/local build (`--dir`, no
 * ORCA_MAC_RELEASE) that checked it would offer to replace itself with a release
 * build, undoing whatever the local build was made to test. So a build is only
 * allowed to update when it was cut as a release AND carries the updater manifest.
 */
export function resolveUpdaterPolicy(input: UpdaterPolicyInput): UpdaterPolicy {
  if (input.isDev) {
    return {
      updatesEnabled: false,
      reason: 'dev',
      explanation: 'Development launch — updates are disabled'
    }
  }
  if (!input.isPackaged) {
    return {
      updatesEnabled: false,
      reason: 'unpackaged',
      explanation: 'Unpackaged launch — updates are disabled'
    }
  }
  if (input.releaseBuild === false) {
    return {
      updatesEnabled: false,
      reason: 'local-build',
      explanation: LOCAL_BUILD_UPDATES_DISABLED_MESSAGE
    }
  }
  if (input.hasUpdateManifest === false) {
    return {
      updatesEnabled: false,
      reason: 'no-update-manifest',
      explanation: LOCAL_BUILD_UPDATES_DISABLED_MESSAGE
    }
  }
  return { updatesEnabled: true }
}

/** True for the two reasons that mean "this is a local build", as opposed to a dev/source launch. */
export function isLocalBuildWithoutUpdates(policy: UpdaterPolicy): boolean {
  return (
    !policy.updatesEnabled &&
    (policy.reason === 'local-build' || policy.reason === 'no-update-manifest')
  )
}

/** Disables the item and explains why when the running build may not take updates. */
export function disabledCheckForUpdatesProps(policy: UpdaterPolicy | undefined): {
  enabled?: boolean
  toolTip?: string
} {
  if (!policy || policy.updatesEnabled) {
    return {}
  }
  return { enabled: false, toolTip: policy.explanation }
}
