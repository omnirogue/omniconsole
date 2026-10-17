import { readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'

/** How long a run's context folder is kept so Resume and Retry still find it. */
export const WORKFLOW_CONTEXT_KEEP_MS = 7 * 24 * 60 * 60 * 1000
const FOLDER = /^ctx-(\d{13})-[0-9a-f]+$/

/** Where every run's context folder lives: the app's data, never a temporary or hidden folder. */
export function workflowContextBase(): string {
  return join(getAppEnvironment().getPath('userData'), 'local-workflow-context')
}

/** The context folders older than the keep window; any other entry is never touched. */
export function workflowContextFoldersToPrune(
  names: readonly string[],
  now: number,
  keepMs = WORKFLOW_CONTEXT_KEEP_MS
): string[] {
  return names.filter((name) => {
    const created = Number(FOLDER.exec(name)?.[1])
    return Number.isFinite(created) && now - created > keepMs
  })
}

/** At host start: context folders older than a week go; a run that old re-reads nothing new. */
export async function sweepWorkflowContextFolders(
  base = workflowContextBase(),
  now = Date.now()
): Promise<string[]> {
  try {
    const names = await readdir(base).catch(() => [] as string[])
    const stale = workflowContextFoldersToPrune(names, now)
    for (const name of stale) {
      await rm(join(base, name), { recursive: true, force: true, maxRetries: 2 })
    }
    return stale
  } catch {
    // Best effort: what is left goes at the next start.
    return []
  }
}

/** Removes one run's context folder (a refused Start's); nothing outside the base is touched. */
export async function discardWorkflowContextFolder(
  root: string,
  base = workflowContextBase()
): Promise<void> {
  const canonicalBase = await realpath(base).catch(() => base)
  if (dirname(root) === canonicalBase && FOLDER.test(basename(root))) {
    await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
  }
}
