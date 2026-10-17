import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { pickAllowedEnv, RUNTIME_ENV_ALLOWLIST } from '../ai-vault/session-scanner-service-env'
import {
  WORKTREE_METADATA_BATCH_MS,
  WORKTREE_METADATA_OUTPUT_BYTES
} from './worktree-metadata-protocol'

const ENTRY_FILENAME = 'worktree-metadata-process-entry.js'

export function resolveWorktreeMetadataEntryPath(
  moduleDir: string = __dirname,
  resourcesPath: string | undefined = process.resourcesPath,
  pathExists: (path: string) => boolean = existsSync
): string {
  const unpack = (dir: string): string =>
    dir.replace(/([\\/])app\.asar(?=([\\/]|$))/, '$1app.asar.unpacked')
  for (const baseDir of [moduleDir, join(moduleDir, '..')].map(unpack)) {
    const candidate = join(baseDir, ENTRY_FILENAME)
    if (pathExists(candidate)) {
      return candidate
    }
  }
  if (resourcesPath) {
    return join(resourcesPath, 'app.asar.unpacked', 'out', 'main', ENTRY_FILENAME)
  }
  return join(process.cwd(), 'out', 'main', ENTRY_FILENAME)
}

export function worktreeMetadataProcessSpec(
  entryPath = resolveWorktreeMetadataEntryPath(),
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ProcessSpec {
  const env = pickAllowedEnv(RUNTIME_ENV_ALLOWLIST, baseEnv, platform)
  env.ELECTRON_RUN_AS_NODE = '1'
  env.UV_THREADPOOL_SIZE = '8'
  return {
    program: process.execPath,
    args: ['--max-old-space-size=96', entryPath],
    // Never inherit a cwd on the very volume whose availability we are probing.
    cwd: dirname(process.execPath),
    env,
    timeoutMs: WORKTREE_METADATA_BATCH_MS,
    maxOutputBytes: WORKTREE_METADATA_OUTPUT_BYTES
  }
}
