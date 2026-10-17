import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { graphCheckLanesInUse } from './graph-check-lane'
import { graphExecutionFolder } from './graph-jev-store'

// A run's folder name as graphExecutionFolder accepts it; any other entry is never touched.
const EXECUTION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** At host start: a crashed run's private copies go, since a resumed run makes new ones anyway. */
export async function sweepGraphCheckLanes(folder?: string): Promise<string[]> {
  const swept: string[] = []
  try {
    const root = folder ?? join(getAppEnvironment().getPath('userData'), 'local-workflow-attempts')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !EXECUTION_ID.test(entry.name)) {
        continue
      }
      const lanes = join(graphExecutionFolder(entry.name, root), 'lanes')
      const found = await lstat(lanes).catch(() => undefined)
      // Asked after the wait: a run that started meanwhile keeps its copies.
      if (!found?.isDirectory() || graphCheckLanesInUse(lanes)) {
        continue
      }
      await rm(lanes, { recursive: true, force: true, maxRetries: 2 })
      swept.push(entry.name)
    }
  } catch {
    // Best effort: what is left is swept at the next start, or by the run itself when it resumes.
  }
  return swept
}
