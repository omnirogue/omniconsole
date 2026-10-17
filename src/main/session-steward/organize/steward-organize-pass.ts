/**
 * One organizing pass (Phase 3), the entry point the steward's rules pass calls: re-file idle
 * local sessions, file a group of related unplaced ones into a new folder, list the rest as
 * "couldn't place", re-title sessions whose goal moved on, and propose merges and projects. Each
 * part is behind its `sessionSteward.organize` switch, the steward stops and the accuracy guard.
 */

import { proposeStewardMerges, type StewardMergeDeps } from './steward-merge-suggest'
import { proposeStewardProjects } from './steward-project-suggest'
import { proposeUnplaced, runStewardRefile, type StewardOrganizeDeps } from './steward-refile'
import { fileStewardCluster } from './steward-refile-clusters'
import { runStewardRetitle, type StewardRetitleDeps } from './steward-retitle'

export type StewardOrganizePassDeps = StewardOrganizeDeps & StewardRetitleDeps & StewardMergeDeps

export type StewardOrganizePassOutcome = {
  moved: string[]
  filed: string[]
  unplaced: string[]
  retitled: string[]
  merges: string[]
  projects: string[]
  /** Why a part did nothing this pass (off, paused, JEV). */
  stopped: string[]
}

const FEATURES = ['refile', 'retitle', 'mergeSuggestions', 'projectSuggestions'] as const

/** One organizing pass over the sidebar as it is now. */
export async function runStewardOrganizePass(
  deps: StewardOrganizePassDeps
): Promise<StewardOrganizePassOutcome> {
  const outcome: StewardOrganizePassOutcome = {
    moved: [],
    filed: [],
    unplaced: [],
    retitled: [],
    merges: [],
    projects: [],
    stopped: []
  }
  if (FEATURES.every((feature) => deps.mode(feature) === 'off')) {
    return { ...outcome, stopped: ['organizing is off'] }
  }
  const rows = await deps.rows()
  const folders = await deps.folders()
  const origins = await deps.batchOrigins().catch(() => null)
  const refile = await runStewardRefile(deps, rows, folders, origins)
  outcome.moved = refile.moved
  if (refile.stopped) {
    outcome.stopped.push(refile.stopped)
  } else {
    const unplaced = rows.filter((observed) => refile.unplaced.includes(observed.row.viewKey))
    outcome.filed = await fileStewardCluster(deps, unplaced, folders)
    outcome.unplaced = refile.unplaced.filter((key) => !outcome.filed.includes(key))
    await proposeUnplaced(deps, rows, outcome.unplaced)
  }
  const retitle = await runStewardRetitle(deps, rows)
  outcome.retitled = retitle.retitled
  if (retitle.stopped) {
    outcome.stopped.push(retitle.stopped)
  }
  outcome.merges = await proposeStewardMerges(deps, rows, origins)
  outcome.projects = await proposeStewardProjects(deps, rows, folders, origins)
  return outcome
}
