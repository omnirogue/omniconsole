import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

const EXECUTABLE = 'omni-pty-process-observer'
// An Electron helper runs from <App>.app/Contents/Frameworks/<Helper>.app/Contents/MacOS/.
const ELECTRON_HELPER_EXEC = /^(.+\.app)\/Contents\/Frameworks\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/

/** Candidate helper paths for this process; the packaged helper lives in the app's Contents/MacOS. */
export function macosPtyProcessObserverCandidates(execPath: string): string[] {
  const candidates = [join(dirname(execPath), EXECUTABLE)]
  // Why: the PTY daemon is forked as the Electron helper, has no app environment, and
  // re-checks managed launches itself; without the outer bundle's Contents/MacOS it never
  // finds the helper and refuses every app-launched session (exit_observer_unavailable).
  const helper = ELECTRON_HELPER_EXEC.exec(execPath)
  if (helper) {
    candidates.push(join(helper[1], 'Contents', 'MacOS', EXECUTABLE))
  }
  return candidates
}

export function resolveMacosPtyProcessObserver(): string | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const candidates = macosPtyProcessObserverCandidates(process.execPath)
  if (hasAppEnvironment()) {
    const environment = getAppEnvironment()
    const appPath = environment.getAppPath()
    candidates.push(join(dirname(environment.getPath('exe')), EXECUTABLE))
    if (appPath.endsWith('app.asar')) {
      candidates.push(join(appPath, '..', '..', 'MacOS', EXECUTABLE))
    }
    if (!environment.isPackaged()) {
      candidates.push(
        join(appPath, 'native', 'pty-process-observer-macos', '.build', 'release', EXECUTABLE)
      )
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Missing native evidence leaves observed launches unsupported.
    }
  }
  return null
}
