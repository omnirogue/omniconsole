import {
  findMergeHolds,
  readMergeWhenReadyBox,
  type MergeHold,
  type MergeWhenReadyBoxState
} from './merge-when-ready-box'

export type MergeWhenReadyCheck = {
  name: string
  state: 'success' | 'failure' | 'pending' | 'neutral'
}

export type MergeWhenReadyLabelEvent = { label: string; login: string | null; at: string }

export type MergeWhenReadyTitleEvent = {
  previousTitle: string
  currentTitle: string
  login: string | null
  at: string
}

/** What the Merge when ready controls need about one PR, read fresh from GitHub. */
export type MergeWhenReadyPullRequestFacts = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  url: string
  author: string | null
  createdAt: string
  baseRefName: string
  mergeable: string | null
  mergeStateStatus: string | null
  labels: string[]
  /** Checks on the head commit, oldest first. */
  checks: MergeWhenReadyCheck[]
  /** Recent label and title changes, oldest first. */
  labelEvents: MergeWhenReadyLabelEvent[]
  titleEvents: MergeWhenReadyTitleEvent[]
  /** GitHub has older label and title changes than these, so who set a hold can be unknown. */
  olderEventsOmitted: boolean
}

export type AttributedMergeHold = MergeHold & { by: string | null; at: string | null }

function titleHasHold(title: string): boolean {
  return findMergeHolds({ title, labels: [] }).length > 0
}

/** Each hold with who set it and when, when GitHub's history shows it. */
export function attributeMergeHolds(facts: MergeWhenReadyPullRequestFacts): AttributedMergeHold[] {
  return findMergeHolds(facts).map((hold) => {
    if (hold.kind === 'label') {
      const event = facts.labelEvents.findLast((entry) => entry.label === hold.label)
      return { ...hold, by: event?.login ?? null, at: event?.at ?? null }
    }
    const added = facts.titleEvents.findLast(
      (entry) => titleHasHold(entry.currentTitle) && !titleHasHold(entry.previousTitle)
    )
    if (added) {
      return { ...hold, by: added.login, at: added.at }
    }
    // Why: no rename added the marker, so it was in the title the PR was opened with, unless
    // the rename that added it is older than the changes GitHub returned.
    const firstRename = facts.titleEvents[0]
    if (!facts.olderEventsOmitted && (!firstRename || titleHasHold(firstRename.previousTitle))) {
      return { ...hold, by: facts.author, at: facts.createdAt }
    }
    return { ...hold, by: null, at: null }
  })
}

export type MergeWhenReadyBlocker =
  | { kind: 'draft' }
  | { kind: 'conflicts'; base: string }
  | { kind: 'checks-failing'; names: string[] }
  | { kind: 'checks-running'; names: string[] }
  | { kind: 'behind'; base: string }
  | { kind: 'blocked' }

/** What stands between an armed PR and its merge, in the order a person would fix them. */
export function findMergeWhenReadyBlockers(
  facts: MergeWhenReadyPullRequestFacts
): MergeWhenReadyBlocker[] {
  const blockers: MergeWhenReadyBlocker[] = []
  if (facts.isDraft) {
    blockers.push({ kind: 'draft' })
  }
  if (facts.mergeable === 'CONFLICTING' || facts.mergeStateStatus === 'DIRTY') {
    blockers.push({ kind: 'conflicts', base: facts.baseRefName })
  }
  // Why: a re-run reports the same name again; the latest result is the one that counts.
  const latest = new Map<string, MergeWhenReadyCheck['state']>()
  for (const check of facts.checks) {
    latest.set(check.name, check.state)
  }
  const failing = [...latest].filter(([, state]) => state === 'failure').map(([name]) => name)
  const running = [...latest].filter(([, state]) => state === 'pending').map(([name]) => name)
  if (failing.length > 0) {
    blockers.push({ kind: 'checks-failing', names: failing })
  }
  if (running.length > 0) {
    blockers.push({ kind: 'checks-running', names: running })
  }
  if (facts.mergeStateStatus === 'BEHIND') {
    blockers.push({ kind: 'behind', base: facts.baseRefName })
  }
  if (facts.mergeStateStatus === 'BLOCKED' && failing.length === 0 && running.length === 0) {
    blockers.push({ kind: 'blocked' })
  }
  return blockers
}

export type MergeWhenReadyStatus =
  | { kind: 'not-open' }
  | { kind: 'no-box' }
  | { kind: 'armed' }
  | { kind: 'held'; holds: AttributedMergeHold[] }
  | { kind: 'ready' }

/**
 * Where one PR stands. Only PRs with the job's box can be armed: the job adds it to PRs into
 * the bases it merges, so a missing box means nothing would act on a tick.
 */
export function mergeWhenReadyStatus(facts: MergeWhenReadyPullRequestFacts): MergeWhenReadyStatus {
  if (facts.state !== 'open') {
    return { kind: 'not-open' }
  }
  const box: MergeWhenReadyBoxState = readMergeWhenReadyBox(facts.body)
  if (box === 'absent') {
    return { kind: 'no-box' }
  }
  if (box === 'ticked') {
    return { kind: 'armed' }
  }
  const holds = attributeMergeHolds(facts)
  return holds.length > 0 ? { kind: 'held', holds } : { kind: 'ready' }
}
