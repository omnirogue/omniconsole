import { describe, expect, it } from 'vitest'

import {
  LOCAL_BUILD_UPDATES_DISABLED_MESSAGE,
  disabledCheckForUpdatesProps,
  isLocalBuildWithoutUpdates,
  resolveUpdaterPolicy
} from './updater-policy'

const releaseInput = {
  isPackaged: true,
  isDev: false,
  hasUpdateManifest: true,
  releaseBuild: true
} as const

describe('resolveUpdaterPolicy', () => {
  it('enables updates only for a packaged release build that carries app-update.yml', () => {
    expect(resolveUpdaterPolicy(releaseInput)).toEqual({ updatesEnabled: true })
  })

  it('disables updates for a local build even when app-update.yml is present', () => {
    const policy = resolveUpdaterPolicy({ ...releaseInput, releaseBuild: false })
    expect(policy).toEqual({
      updatesEnabled: false,
      reason: 'local-build',
      explanation: LOCAL_BUILD_UPDATES_DISABLED_MESSAGE
    })
    expect(isLocalBuildWithoutUpdates(policy)).toBe(true)
  })

  it('disables updates for a --dir bundle that has no app-update.yml', () => {
    const policy = resolveUpdaterPolicy({
      ...releaseInput,
      releaseBuild: null,
      hasUpdateManifest: false
    })
    expect(policy).toMatchObject({ updatesEnabled: false, reason: 'no-update-manifest' })
    expect(isLocalBuildWithoutUpdates(policy)).toBe(true)
  })

  it('keeps older release bundles without the marker field updatable', () => {
    expect(resolveUpdaterPolicy({ ...releaseInput, releaseBuild: null })).toEqual({
      updatesEnabled: true
    })
  })

  it('does not treat an unknown resources directory as a local build', () => {
    // Why: unit tests and source launches have no process.resourcesPath; the
    // packaged/dev gates own those cases and must keep their existing behavior.
    expect(
      resolveUpdaterPolicy({ ...releaseInput, hasUpdateManifest: null, releaseBuild: null })
    ).toEqual({ updatesEnabled: true })
  })

  it('reports dev and unpackaged launches as their own reasons, not as local builds', () => {
    const dev = resolveUpdaterPolicy({ ...releaseInput, isDev: true })
    const unpackaged = resolveUpdaterPolicy({ ...releaseInput, isPackaged: false })
    expect(dev).toMatchObject({ updatesEnabled: false, reason: 'dev' })
    expect(unpackaged).toMatchObject({ updatesEnabled: false, reason: 'unpackaged' })
    expect(isLocalBuildWithoutUpdates(dev)).toBe(false)
    expect(isLocalBuildWithoutUpdates(unpackaged)).toBe(false)
  })
})

describe('disabledCheckForUpdatesProps', () => {
  it('disables the menu item with the explanation as tooltip only when updates are off', () => {
    expect(disabledCheckForUpdatesProps(undefined)).toEqual({})
    expect(disabledCheckForUpdatesProps({ updatesEnabled: true })).toEqual({})
    expect(
      disabledCheckForUpdatesProps({
        updatesEnabled: false,
        reason: 'local-build',
        explanation: LOCAL_BUILD_UPDATES_DISABLED_MESSAGE
      })
    ).toEqual({ enabled: false, toolTip: LOCAL_BUILD_UPDATES_DISABLED_MESSAGE })
  })
})
