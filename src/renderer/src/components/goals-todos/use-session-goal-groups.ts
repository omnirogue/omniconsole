import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { sessionGoalGroups, type SessionGoalGroup } from '../../../../shared/session-goal-groups'
import { sessionPullRequestKey } from '../../../../shared/session-pull-request-facts'
import { sessionPullRequestMentions } from '../../../../shared/session-pull-request-refs'
import type { SessionPullRequestMention } from '../../../../shared/session-pull-request-refs'
import { approveSessionPullRequests, useApprovedSessionPullRequests } from './session-approvals'
import {
  useSessionPullRequestFacts,
  type SessionPullRequestReadMode
} from './session-pull-request-facts-store'

const NO_MESSAGES: readonly NativeChatMessage[] = []

/** A conversation's goals, from the PRs its AI named and GitHub's facts about them. */
export function useSessionGoalGroups(
  messages: readonly NativeChatMessage[] | undefined,
  mode: SessionPullRequestReadMode,
  indexed?: readonly SessionPullRequestMention[]
): SessionGoalGroup[] {
  const transcript = messages ?? NO_MESSAGES
  const mentions = useMemo(
    () => [
      ...new Map(
        [...(indexed ?? []), ...sessionPullRequestMentions(transcript)].map((pr) => [
          sessionPullRequestKey(pr),
          pr
        ])
      ).values()
    ],
    [transcript, indexed]
  )
  const refs = useMemo(
    () => mentions.map(({ owner, repo, number }) => ({ owner, repo, number })),
    [mentions]
  )
  const facts = useSessionPullRequestFacts(refs, mode)
  const approved = useApprovedSessionPullRequests()
  return useMemo(
    () =>
      sessionGoalGroups(
        mentions,
        new Map(facts.map((pr) => [sessionPullRequestKey(pr), pr])),
        approved
      ),
    [mentions, facts, approved]
  )
}

/** The person's own approval of a goal's unmerged PRs, kept on this computer. */
export function approveSessionGoal(group: SessionGoalGroup): void {
  approveSessionPullRequests(
    group.pullRequests
      .filter((pr) => pr.state === 'open' || pr.state === 'draft')
      .map(sessionPullRequestKey)
  )
}
