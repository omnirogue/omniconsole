import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { readMergeWhenReadyBox } from '../../../../../shared/github/merge-when-ready-box'
import type { MergeWhenReadyPullRequestFacts } from '../../../../../shared/github/merge-when-ready-facts'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { readMergeWhenReadyFacts, type MergeWhenReadyClient } from './merge-when-ready-actions'
import { createMergeWhenReadyClient } from './merge-when-ready-client'

type MergeWhenReadyRead = {
  prKey: string
  facts: MergeWhenReadyPullRequestFacts | null
  error: string | null
}

export type MergeWhenReadyState = {
  number: number
  client: MergeWhenReadyClient | null
  facts: MergeWhenReadyPullRequestFacts | null
  error: string | null
  loaded: boolean
  /** The PR carries the box, so "Merge when ready" names the box button here. */
  boxPresent: boolean
  refresh: () => void
}

/**
 * Reads one open PR's box, holds and checks by owner/repo, so the button needs no local
 * clone. Facts stay on screen while a refresh runs; a new PR starts empty.
 */
export function useMergeWhenReady(args: {
  item: GitHubWorkItem
  repoId: string | null
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubOwnerRepo
}): MergeWhenReadyState {
  const { item } = args
  const open = item.type === 'pr' && (item.state === 'open' || item.state === 'draft')
  const slug = open ? resolvePullRequestRepo(item, args.projectOrigin) : null
  const prKey = slug ? `${slug.host}/${slug.owner}/${slug.repo}#${item.number}` : null
  const [read, setRead] = useState<MergeWhenReadyRead | null>(null)
  const [nonce, setNonce] = useState(0)
  const client = slug
    ? createMergeWhenReadyClient({
        slug,
        repoId: item.repoId || args.repoId,
        repoPath: args.repoPath,
        sourceContext: args.sourceContext
      })
    : null
  // Why: a list refresh or a local edit to the PR changes these, so the facts are re-read.
  const requestKey = prKey
    ? [prKey, item.updatedAt, item.state, item.title, item.labels.join(','), item.headSha, nonce]
        .map(String)
        .join('|')
    : null

  const loadFacts = useEffectEvent(async () =>
    client ? (await readMergeWhenReadyFacts(client, [item.number])).byNumber.get(item.number) : null
  )

  useEffect(() => {
    if (requestKey === null || prKey === null) {
      return
    }
    let current = true
    void loadFacts()
      .then((facts) => {
        if (current) {
          setRead({ prKey, facts: facts ?? null, error: null })
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setRead({
            prKey,
            facts: null,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      current = false
    }
  }, [requestKey, prKey])

  const refresh = useCallback(() => setNonce((value) => value + 1), [])
  const own = read !== null && read.prKey === prKey ? read : null
  return {
    number: item.number,
    client,
    facts: own?.facts ?? null,
    error: own?.error ?? null,
    loaded: own !== null,
    boxPresent: own?.facts ? readMergeWhenReadyBox(own.facts.body) !== 'absent' : false,
    refresh
  }
}
