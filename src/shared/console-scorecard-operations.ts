import { z } from 'zod'
import {
  countMap,
  countOrZero,
  looseCount,
  looseLabel,
  looseText,
  scorecardSource
} from './console-scorecard-leaves'

/**
 * Operations: projects → objectives → tasks → PRs → QA → deployments → who is
 * working.
 *
 * The task lists are `optional()` rather than defaulted to `[]` on purpose: an absent
 * list and an empty list are different facts, and a default erases the difference so a
 * count nobody measured renders as 0. Callers read `?? []` when they iterate and check
 * presence when they count.
 *
 * Two honesty rules the collector writes into this shape:
 *  - The task lists are CAPPED for the page, so each carries its own whole count.
 *    A list of 25 beside a count of 60 must read as "25 of 60", never as 25.
 *  - A repository that reported nothing makes the aggregate unknown rather than a
 *    lower bound wearing a total's clothes.
 */

export const opsPrRow = z
  .object({
    number: looseCount,
    title: looseLabel(),
    author: looseText,
    updated_at: looseText,
    merged_at: looseText,
    draft: z.boolean().default(false)
  })
  .passthrough()

export const opsRun = z
  .object({
    name: looseText,
    status: looseText,
    conclusion: looseText,
    at: looseText,
    branch: looseText
  })
  .passthrough()

export const opsRepo = z
  .object({
    repo: z.string(),
    open_prs: looseCount,
    merged_7d: looseCount,
    open_issues: looseCount,
    commits_7d: looseCount,
    main_ci: opsRun.nullable().optional(),
    pushed_at: looseText,
    open_pr_list: z.array(opsPrRow).default([]),
    merged_list: z.array(opsPrRow).default([]),
    /** The latest workflow run whose name says "deploy", on any branch. */
    deploy: opsRun.nullable().optional()
  })
  .passthrough()

/** One board card, briefly — enough to list it and open it. */
export const opsTaskBrief = z
  .object({
    id: z.string(),
    title: looseLabel(),
    status: looseText,
    execution_state: looseText,
    next_action: looseText,
    owner: looseText,
    domain: looseText,
    updated_at: looseText,
    source: looseText,
    company: looseText
  })
  .passthrough()

export const opsSession = z
  .object({
    id: z.string(),
    title: looseLabel(),
    model: looseText,
    agent: looseText,
    task_id: looseText,
    since: looseText
  })
  .passthrough()

export const opsDomainRow = z
  .object({
    name: z.string(),
    live: countOrZero,
    blocked: countOrZero,
    in_progress: countOrZero
  })
  .passthrough()

export const opsTasks = z
  .object({
    by_status: countMap,
    live: looseCount,
    in_progress: looseCount,
    blocked: looseCount,
    awaiting_approval: looseCount,
    done_7d: looseCount,
    by_domain: z.array(opsDomainRow).default([]),
    blocked_reasons: z
      .array(z.object({ reason: looseLabel('unstated'), n: countOrZero }).passthrough())
      .default([])
  })
  .passthrough()

export const opsRoutines = z
  .object({
    active: looseCount,
    paused: looseCount,
    pending: looseCount,
    failing: looseCount,
    items: z
      .array(
        z
          .object({
            id: z.string(),
            title: looseLabel(),
            status: z.string().default(''),
            last_exit: looseCount,
            last_run_at: looseText
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough()

export const opsCompany = z
  .object({
    slug: looseText,
    tasks: opsTasks.optional(),
    github: z.array(opsRepo).default([]),
    routines: opsRoutines.optional(),
    waiting_on_human: z.array(opsTaskBrief).optional(),
    waiting_on_ai: z.array(opsTaskBrief).optional(),
    recently_done: z.array(opsTaskBrief).optional(),
    top_live: z.array(opsTaskBrief).optional(),
    /** The whole counts; the lists above are capped for the page. */
    waiting_on_human_count: looseCount,
    waiting_on_ai_count: looseCount,
    recently_done_count: looseCount,
    qa: z
      .object({ count: looseCount, items: z.array(opsTaskBrief).default([]) })
      .passthrough()
      .optional(),
    projects_active: looseCount,
    objectives_active: looseCount,
    sessions_working: z.array(opsSession).optional(),
    sources: z.array(scorecardSource).optional()
  })
  .passthrough()

export const portfolioOperations = z
  .object({
    live: looseCount,
    in_progress: looseCount,
    blocked: looseCount,
    awaiting_approval: looseCount,
    waiting_on_human: looseCount,
    waiting_on_ai: looseCount,
    done_7d: looseCount,
    projects_active: looseCount,
    objectives_active: looseCount,
    open_prs: looseCount,
    merged_7d: looseCount,
    open_issues: looseCount,
    commits_7d: looseCount,
    ci_failing: looseCount,
    sessions_working: looseCount,
    routines_failing: looseCount,
    recently_done: z.array(opsTaskBrief).default([])
  })
  .passthrough()

export type OpsRun = z.infer<typeof opsRun>
export type OpsRepo = z.infer<typeof opsRepo>
export type OpsPrRow = z.infer<typeof opsPrRow>
export type OpsTaskBrief = z.infer<typeof opsTaskBrief>
export type OpsSession = z.infer<typeof opsSession>
export type OpsDomainRow = z.infer<typeof opsDomainRow>
export type OpsTasks = z.infer<typeof opsTasks>
export type OpsRoutines = z.infer<typeof opsRoutines>
export type OpsCompany = z.infer<typeof opsCompany>
export type PortfolioOperations = z.infer<typeof portfolioOperations>

/**
 * A repository field summed across repos, or null. One repo reporting nothing
 * makes the total unknown: a two-of-three sum shown as a total is a lower bound
 * pretending to be a measurement.
 */
export function repoTotal(
  repos: readonly OpsRepo[] | undefined,
  field: 'open_prs' | 'merged_7d' | 'open_issues' | 'commits_7d'
): number | null {
  if (!repos || repos.length === 0) {
    return null
  }
  return repos.every((repo) => typeof repo[field] === 'number')
    ? repos.reduce((total, repo) => total + (repo[field] as number), 0)
    : null
}

/** Repos whose main branch last concluded in failure. Only a real failure counts. */
export function failingRepos(repos: readonly OpsRepo[] | undefined): OpsRepo[] {
  return (repos ?? []).filter((repo) => repo.main_ci?.conclusion === 'failure')
}

/** "25 of 60" when the list was capped, otherwise just the length. */
export function listCoverage(
  shown: number,
  whole: number | null | undefined
): { shown: number; whole: number | null; capped: boolean } {
  const total = typeof whole === 'number' && Number.isFinite(whole) ? whole : null
  return { shown, whole: total, capped: total !== null && total > shown }
}
