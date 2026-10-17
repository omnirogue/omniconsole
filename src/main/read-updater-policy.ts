import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { resolveUpdaterPolicy, type UpdaterPolicy, type UpdaterPolicyInput } from './updater-policy'

const UPDATE_MANIFEST_FILENAME = 'app-update.yml'
// Why: the same marker config/scripts/mac-build-compatibility.cjs writes for every mac build;
// ORCA_MAC_RELEASE=1 is the single switch that stamps `releaseBuild: true` into it.
const LOCAL_BUILD_MARKER_FILENAME = 'omni-local-build.json'

function readReleaseBuildMarker(resourcesPath: string): boolean | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(resourcesPath, LOCAL_BUILD_MARKER_FILENAME), 'utf8')
    ) as { releaseBuild?: unknown }
    return typeof parsed.releaseBuild === 'boolean' ? parsed.releaseBuild : null
  } catch {
    return null
  }
}

export function readUpdaterPolicyInput(
  resourcesPath: string | undefined = process.resourcesPath
): UpdaterPolicyInput {
  const hasResources = typeof resourcesPath === 'string' && resourcesPath.length > 0
  return {
    isPackaged: app.isPackaged,
    isDev: is.dev,
    hasUpdateManifest: hasResources
      ? existsSync(join(resourcesPath, UPDATE_MANIFEST_FILENAME))
      : null,
    releaseBuild: hasResources ? readReleaseBuildMarker(resourcesPath) : null
  }
}

export function readUpdaterPolicy(): UpdaterPolicy {
  return resolveUpdaterPolicy(readUpdaterPolicyInput())
}
