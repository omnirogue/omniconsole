// A session's progress as a few plain milestones — Prototype built, Approved, Live on each
// brand — derived only from GitHub facts, so a row turns green only when something proves it.

import { sessionPullRequestKey, type SessionPullRequestFacts } from './session-pull-request-facts'

/** done ✓ proven · now ● happening · you ! waiting on the person · fail ✕ blocked · todo ○ */
export type SessionMilestoneStatus = 'done' | 'now' | 'you' | 'fail' | 'todo'

export type SessionMilestone =
  | { key: 'built'; kind: 'built'; status: 'done'; pullRequests: number[]; drafts: number }
  | { key: 'checks'; kind: 'checks'; status: 'fail' | 'now'; pullRequests: number[] }
  | { key: 'approved'; kind: 'approved'; status: SessionMilestoneStatus }
  | {
      key: string
      kind: 'live'
      status: SessionMilestoneStatus
      target: string
      /** Live PRs of the target's total, for "1 of 2 live". */
      live: number
      total: number
      url: string | null
    }
  | { key: 'merged'; kind: 'merged'; status: 'done' | 'todo' }

/** Deploy branches whose brand name differs from the branch name. */
const DEPLOY_TARGET_LABELS: Readonly<Record<string, string>> = {
  'prod-omnirogue': 'OmniRogue',
  'prod-betacorp': 'BetaCorp',
  'prod-acme': 'ACME'
}

/** "prod-omnirogue" → "OmniRogue"; an unknown branch keeps its name. */
export function deployTargetLabel(branch: string): string {
  return DEPLOY_TARGET_LABELS[branch.toLowerCase()] ?? branch
}

function numbers(prs: readonly SessionPullRequestFacts[]): number[] {
  return prs.map((pr) => pr.number).sort((a, b) => a - b)
}

function checksMilestone(open: readonly SessionPullRequestFacts[]): SessionMilestone | null {
  const failing = open.filter((pr) => pr.checks === 'failure')
  if (failing.length > 0) {
    return { key: 'checks', kind: 'checks', status: 'fail', pullRequests: numbers(failing) }
  }
  const running = open.filter((pr) => pr.checks === 'pending')
  return running.length > 0
    ? { key: 'checks', kind: 'checks', status: 'now', pullRequests: numbers(running) }
    : null
}

function approvalStatus(
  active: readonly SessionPullRequestFacts[],
  open: readonly SessionPullRequestFacts[],
  approvedByYou: ReadonlySet<string>
): SessionMilestoneStatus {
  const approved = (pr: SessionPullRequestFacts): boolean =>
    pr.state === 'merged' || pr.approved || approvedByYou.has(sessionPullRequestKey(pr))
  if (active.every(approved)) {
    return 'done'
  }
  // Why amber only here: a draft or a red check is the AI's to fix, not the person's to approve.
  const ready = open.every(
    (pr) =>
      approved(pr) || (pr.state === 'open' && pr.checks !== 'failure' && pr.checks !== 'pending')
  )
  return ready ? 'you' : 'todo'
}

type LiveMilestone = Extract<SessionMilestone, { kind: 'live' }>

function liveStatus(
  prs: readonly SessionPullRequestFacts[],
  live: number,
  failed: boolean
): SessionMilestoneStatus {
  if (failed) {
    return 'fail'
  }
  if (live === prs.length) {
    return 'done'
  }
  const moving = prs.some(
    (pr) =>
      pr.state === 'merged' && (pr.deploy.status === 'running' || pr.deploy.status === 'waiting')
  )
  return moving || live > 0 ? 'now' : 'todo'
}

function liveMilestone(branch: string, prs: readonly SessionPullRequestFacts[]): LiveMilestone {
  const live = prs.filter((pr) => pr.state === 'merged' && pr.deploy.status === 'success')
  const failed = prs.find((pr) => pr.state === 'merged' && pr.deploy.status === 'failure')
  const status = liveStatus(prs, live.length, failed !== undefined)
  const shown = failed ?? live[0] ?? prs.find((pr) => pr.deploy.url) ?? null
  return {
    key: `live:${branch}`,
    kind: 'live',
    status,
    target: deployTargetLabel(branch),
    live: live.length,
    total: prs.length,
    url: shown?.deploy.url ?? null
  }
}

/**
 * The milestones for a session's pull requests, in order. Closed-unmerged PRs are ignored; with
 * none left there are no milestones. A base branch with deploy workflows gets a "Live on …" row;
 * PRs into any other branch share one "Merged" row.
 */
export function sessionMilestones(
  prs: readonly SessionPullRequestFacts[],
  /** Keys (`owner/repo#n`) of pull requests the person approved on the card. */
  approvedByYou: ReadonlySet<string> = new Set()
): SessionMilestone[] {
  const active = prs.filter((pr) => pr.state !== 'closed')
  if (active.length === 0) {
    return []
  }
  const open = active.filter((pr) => pr.state !== 'merged')
  const milestones: SessionMilestone[] = [
    {
      key: 'built',
      kind: 'built',
      status: 'done',
      pullRequests: numbers(active),
      drafts: active.filter((pr) => pr.state === 'draft').length
    }
  ]
  const checks = checksMilestone(open)
  if (checks) {
    milestones.push(checks)
  }
  milestones.push({
    key: 'approved',
    kind: 'approved',
    status: approvalStatus(active, open, approvedByYou)
  })
  const byBranch = new Map<string, SessionPullRequestFacts[]>()
  const undeployed: SessionPullRequestFacts[] = []
  for (const pr of active) {
    if (pr.deploy.workflows.length === 0) {
      undeployed.push(pr)
      continue
    }
    byBranch.set(pr.baseBranch, [...(byBranch.get(pr.baseBranch) ?? []), pr])
  }
  milestones.push(
    ...[...byBranch]
      .map(([branch, group]) => liveMilestone(branch, group))
      .sort((a, b) => a.target.localeCompare(b.target))
  )
  if (undeployed.length > 0) {
    milestones.push({
      key: 'merged',
      kind: 'merged',
      status: undeployed.every((pr) => pr.state === 'merged') ? 'done' : 'todo'
    })
  }
  return milestones
}

/** Whether every milestone is proven: the goal these PRs served is finished. */
export function sessionMilestonesDone(milestones: readonly SessionMilestone[]): boolean {
  return milestones.length > 0 && milestones.every((milestone) => milestone.status === 'done')
}
