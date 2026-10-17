import { githubProjectHost } from '../../../../../shared/github/project-identity'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type {
  MergeAllPlan,
  MergeAllRun
} from '../../github/merge-when-ready/merge-when-ready-actions'
import { resolveTaskPullRequestRepo } from './github-reviewer-suggestions'

export type MergeAllGroup = {
  key: string
  slug: GitHubOwnerRepo
  repoId: string
  numbers: number[]
}

/**
 * The listed open PRs, one group per GitHub repo and local repo entry: each group is read
 * and written through its own repo's runtime, in list order.
 */
export function groupMergeAllCandidates(items: readonly GitHubWorkItem[]): MergeAllGroup[] {
  const groups = new Map<string, MergeAllGroup>()
  for (const item of items) {
    if (item.type !== 'pr' || (item.state !== 'open' && item.state !== 'draft')) {
      continue
    }
    const slug = resolveTaskPullRequestRepo(item)
    if (!slug) {
      continue
    }
    const host = githubProjectHost(slug.host)
    const repoKey = `${host}/${slug.owner}/${slug.repo}`.toLowerCase()
    const key = `${repoKey}|${item.repoId}`
    const group = groups.get(key) ?? {
      key,
      slug: { owner: slug.owner, repo: slug.repo, host },
      repoId: item.repoId,
      numbers: []
    }
    if (!group.numbers.includes(item.number)) {
      group.numbers.push(item.number)
    }
    groups.set(key, group)
  }
  return [...groups.values()]
}

export type MergeAllGroupPreview = {
  group: MergeAllGroup
  plan: MergeAllPlan | null
  error: string | null
}

export type MergeAllTotals = {
  arm: number
  skip: number
  unreadable: number
}

export function countMergeAllPreview(previews: readonly MergeAllGroupPreview[]): MergeAllTotals {
  return previews.reduce(
    (totals, preview) => ({
      arm: totals.arm + (preview.plan?.arm.length ?? 0),
      skip: totals.skip + (preview.plan?.skip.length ?? 0),
      unreadable: totals.unreadable + (preview.plan ? 0 : preview.group.numbers.length)
    }),
    { arm: 0, skip: 0, unreadable: 0 }
  )
}

export type MergeAllGroupResult = {
  group: MergeAllGroup
  /** The PRs the preview showed as "will turn on"; only these are written. */
  requested: number[]
  run: MergeAllRun | null
  error: string | null
}

export type MergeAllResultTotals = {
  armed: number
  failed: number
  unverified: number
  skipped: number
}

export function countMergeAllResults(
  results: readonly MergeAllGroupResult[]
): MergeAllResultTotals {
  return results.reduce(
    (totals, result) => ({
      armed: totals.armed + (result.run?.armed.length ?? 0),
      failed: totals.failed + (result.run ? result.run.failed.length : result.requested.length),
      unverified: totals.unverified + (result.run?.unverified.length ?? 0),
      skipped: totals.skipped + (result.run?.plan.skip.length ?? 0)
    }),
    { armed: 0, failed: 0, unverified: 0, skipped: 0 }
  )
}
