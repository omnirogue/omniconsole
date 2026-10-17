// One session can pursue several goals in turn ("ship the toggle", then "a new prototype").
// A goal here is a run of pull requests: a new one starts when a PR is first named after every
// PR of the goal before it has settled. Mechanical, from GitHub facts and transcript order only.

import {
  sessionMilestones,
  sessionMilestonesDone,
  type SessionMilestone
} from './session-milestones'
import {
  isSettledSessionPullRequest,
  sessionPullRequestKey,
  type SessionPullRequestFacts
} from './session-pull-request-facts'
import type { SessionPullRequestMention } from './session-pull-request-refs'

export type SessionGoalGroup = {
  key: string
  /** A plain name from the first PR's title ("Combine generation settings in one popover"). */
  title: string
  pullRequests: SessionPullRequestFacts[]
  milestones: SessionMilestone[]
  done: boolean
}

const CONVENTIONAL_PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s*/i
/** "OmniRogue: …", "BetaCorp - …": the brand a paired PR targets, not what it does. */
const BRAND_PREFIX = /^(?:omnirogue|betacorp|acme|apexlabs)\s*[:\-–—]\s*/i

/** "fix(create): align OmniRogue catalog options" → "Align OmniRogue catalog options". */
export function cleanPullRequestTitle(title: string): string {
  const bare = title.trim().replace(CONVENTIONAL_PREFIX, '').replace(BRAND_PREFIX, '').trim()
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : title.trim()
}

function settledBefore(group: readonly SessionPullRequestFacts[], at: number | null): boolean {
  if (at === null || !group.every(isSettledSessionPullRequest)) {
    return false
  }
  return group.every((pr) => pr.settledAt !== null && pr.settledAt < at)
}

function goalGroup(
  prs: SessionPullRequestFacts[],
  approvedByYou: ReadonlySet<string>
): SessionGoalGroup {
  const milestones = sessionMilestones(prs, approvedByYou)
  return {
    key: prs.map(sessionPullRequestKey).join(','),
    title: cleanPullRequestTitle(prs[0]?.title ?? ''),
    pullRequests: prs,
    milestones,
    done: sessionMilestonesDone(milestones)
  }
}

/**
 * The session's goals, oldest first; the last is the one in progress. PRs without facts yet are
 * skipped, and a goal left with no milestones (all closed unmerged) is dropped.
 */
export function sessionGoalGroups(
  mentions: readonly SessionPullRequestMention[],
  facts: ReadonlyMap<string, SessionPullRequestFacts>,
  approvedByYou: ReadonlySet<string> = new Set()
): SessionGoalGroup[] {
  const runs: SessionPullRequestFacts[][] = []
  for (const mention of mentions) {
    const pr = facts.get(sessionPullRequestKey(mention))
    if (!pr) {
      continue
    }
    const current = runs.at(-1)
    if (current && !settledBefore(current, mention.firstAt)) {
      current.push(pr)
    } else {
      runs.push([pr])
    }
  }
  return runs
    .map((run) => goalGroup(run, approvedByYou))
    .filter((group) => group.milestones.length > 0)
}
