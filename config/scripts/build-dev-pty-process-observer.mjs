import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function buildDevPtyProcessObserver(repoRoot, appPath) {
  try {
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'config', 'scripts', 'build-pty-process-observer-macos.mjs'),
        '--single-arch',
        '--output',
        join(appPath, 'Contents', 'MacOS', 'omni-pty-process-observer')
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(
      `[omni-dev] process observer unavailable (observed launches stay closed): ${error?.message ?? error}`
    )
  }
}
