import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getGitHubMutationSettings } from '@/components/github/github-work-item-edit-mutations'
import { notifyWorkItemDetailsMutation } from '@/components/github/github-work-item-comment-mutations'
import { githubProjectHost } from '../../../../../shared/github/project-identity'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { MergeWhenReadyFactsBySlugResult } from '../../../../../shared/github/project-result-types'
import type { MergeWhenReadyClient } from './merge-when-ready-actions'

type SlugMutationResult = Awaited<ReturnType<typeof window.api.gh.updatePullRequestBySlug>>

/**
 * Reads and writes one repo's PRs by owner/repo, so Merge when ready works without a local
 * clone. Calls run where this repo's GitHub calls run: a remote runtime when the task source
 * or the repo lives there, else this app.
 */
export function createMergeWhenReadyClient(args: {
  slug: GitHubOwnerRepo
  repoId: string | null | undefined
  repoPath?: string | null
  sourceContext?: TaskSourceContext | null
}): MergeWhenReadyClient {
  const slug = {
    owner: args.slug.owner,
    repo: args.slug.repo,
    host: githubProjectHost(args.slug.host)
  }
  const target = () =>
    getActiveRuntimeTarget(
      args.sourceContext?.provider === 'github'
        ? getTaskSourceRuntimeSettings(args.sourceContext)
        : getGitHubMutationSettings(args.repoId)
    )
  const afterRemoteWrite = (number: number) =>
    notifyWorkItemDetailsMutation(
      {
        repoPath: args.repoPath ?? '',
        repoId: args.repoId ?? undefined,
        sourceContext: args.sourceContext,
        type: 'pr',
        number
      },
      { local: false }
    )

  return {
    readFacts: async (numbers) => {
      const runtime = target()
      const params = { ...slug, numbers }
      const result =
        runtime.kind === 'environment'
          ? await callRuntimeRpc<MergeWhenReadyFactsBySlugResult>(
              runtime,
              'github.project.mergeWhenReadyFactsBySlug',
              params,
              { timeoutMs: 60_000 }
            )
          : await window.api.gh.mergeWhenReadyFactsBySlug(params)
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      return { pullRequests: result.pullRequests, missing: result.missing }
    },
    updatePullRequest: async (number, updates) => {
      const runtime = target()
      const params = { ...slug, number, updates }
      const result =
        runtime.kind === 'environment'
          ? await callRuntimeRpc<SlugMutationResult>(
              runtime,
              'github.project.updatePullRequestBySlug',
              params,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updatePullRequestBySlug(params)
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      if (runtime.kind === 'environment') {
        afterRemoteWrite(number)
      }
    },
    removeLabels: async (number, labels) => {
      const runtime = target()
      const params = { ...slug, number, updates: { removeLabels: labels } }
      const result =
        runtime.kind === 'environment'
          ? await callRuntimeRpc<SlugMutationResult>(
              runtime,
              'github.project.updateIssueBySlug',
              params,
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.updateIssueBySlug(params)
      if (!result.ok) {
        throw new Error(result.error.message)
      }
      if (runtime.kind === 'environment') {
        afterRemoteWrite(number)
      }
    }
  }
}
