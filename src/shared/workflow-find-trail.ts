import type { FindImportReceipt } from './workflow-graph'

/** Rules 3 screens fixed pages in original pool order. */
export const WORKFLOW_FIND_PAGE_SIZE = 100

/** One option as Find the best shows it: its title, its JEV score (0–4) and who proposed it. */
export type WorkflowFindPick = {
  key: string
  title: string
  detail: string
  /** JEV's score for this list: overall, or on the list's rubric line. */
  score?: number
  by: string
}

/** One option in the results, with every score it got; the rows run best first. */
export type WorkflowFindRow = {
  key: string
  title: string
  detail: string
  url?: string
  /** What every judge path (and every continuation) reads instead of detail: never an owner's own
   * words for a GitHub repository, its title and link. Safe to reuse anywhere a judge already saw it. */
  judgeText: string
  by: string
  /** JEV's overall score (0–4); absent when JEV did not score it. */
  score?: number
  /** JEV's score on each of the trail's `criteria`, in order; null where it gave none. */
  scores: (number | null)[]
  /** Its place in the head-to-head final, when judges placed it there. */
  finalPlace?: number
  finalist?: true
  /** One of the best `keep`: the report lists it. */
  kept?: true
  /** GitHub's facts for the repository it names, as the judges read them. */
  facts?: string
  /** The person's check on a complete version: it outranks every judge. */
  check?: { passed: boolean; score?: number; unavailable?: true }
  /** find-screen@2: JEV could not score it, and why; never read as a low score. */
  notScored?: string
}

/** Where the results files went, or why they could not be written (set by the host). */
export type WorkflowFindSaved = { folder: string; files: string[] } | { error: string }

/**
 * Where a Find the best run stands. The shortlists come from JEV's scores of every option, and
 * the winner from the head-to-head final among the overall top options.
 */
export type WorkflowFindTrail = {
  stage: 'options' | 'check' | 'facts' | 'screen' | 'final' | 'done' | 'failed'
  reason?: string
  /** Options in the pool, after merging duplicates. */
  pool: number
  /** Where the options came from: the models' lists, their complete versions, or the person's list. */
  source: 'generated' | 'versions' | 'list'
  /** Your list only: entries merged in as duplicates by title, detail and url together. */
  importMerged?: number
  /** The immutable record of what happened when this list was imported. */
  importReceipt?: FindImportReceipt
  /** Complete versions under the person's check: how many ran it, passed, and could not run it. */
  check?: { command: string; checked: number; passed: number; unavailable: number }
  /** A pool of repositories: how many GitHub had facts for, and the ones it did not (named). */
  facts?: {
    repos: number
    fetched: number
    failed: string[]
    error?: string
    /** Named repositories past the per-run fetch cap: real options, just not asked about. */
    notFetched?: number
  }
  /** The person's GitHub search: what was asked, what joined the pool, and what could not. */
  harvest?: {
    query: string
    found: number
    /** Results GitHub named with no usable owner/name, so nothing about them could be trusted. */
    dropped: number
    error?: string
  }
  /** Options with and without an overall JEV score; missing scores are never guessed. */
  scored?: number
  unscored?: number
  /** find-screen@2: each option JEV could not score, why, and whether it joined the final. */
  notScored?: { key: string; title: string; reason: string; finalist?: true }[]
  screening?: { options: number; pages: number }
  criterionLeaders?: {
    key: string
    title: string
    criterion: string
    /** kept: added to the shortlist. already: was there anyway. omitted: the cap left no room. */
    status: 'kept' | 'already' | 'omitted'
  }[]
  top: number
  /** How many of the best the report brings back. */
  keep?: number
  /** The finalists, in JEV's score order. */
  overall: WorkflowFindPick[]
  /** The top options on each line of the person's rubric; empty without one. */
  byCriterion: { criterion: string; picks: WorkflowFindPick[] }[]
  winner?: WorkflowFindPick
  /** Who decided the final: JEV, the model judges, or the screen's order when neither could. */
  decidedBy?: ('check' | 'jev' | 'models' | 'screen')[]
  jevUnsure?: true
  /** Once done: the lines of the rubric JEV scored on, and every option best first. */
  criteria?: string[]
  rows?: WorkflowFindRow[]
  saved?: WorkflowFindSaved
}

const screeningPlural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** Plain report text, alongside the backend's other generated report paragraphs. */
export function workflowFindScreeningText(trail: WorkflowFindTrail): string[] {
  if (!trail.screening) {
    return []
  }
  const noun = trail.source === 'versions' ? 'version' : 'option'
  return [
    `Screened ${screeningPlural(trail.screening.options, noun)} across ` +
      `${screeningPlural(trail.screening.pages, 'page')}; ${trail.overall.length} advanced to the shortlist.`,
    ...(trail.criterionLeaders ?? []).map((leader) =>
      leader.status === 'kept'
        ? `Kept "${leader.title}" in the shortlist because it scored highest for "${leader.criterion}".`
        : leader.status === 'already'
          ? `"${leader.title}" also scored highest for "${leader.criterion}"; it was already in the shortlist.`
          : `"${leader.title}" scored highest for "${leader.criterion}" but could not fit: the shortlist was already full of other leaders.`
    )
  ]
}
