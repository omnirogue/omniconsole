// What GitHub says about a pull request a session produced, reduced to the facts its progress
// milestones need: state, approval, checks, and whether the merge has been deployed. Parsing is
// pure; the main process runs `gh` and hands the JSON here.

import type { CheckStatus } from './github/pull-request-types'
import { derivePRCheckStatusFromRollup } from './pr-check-status'

export type SessionPullRequestRef = { owner: string; repo: string; number: number }

export type SessionPullRequestState = 'open' | 'draft' | 'merged' | 'closed'

/** `waiting`: merged, but no deploy run that includes the merge has started yet. */
export type SessionDeployStatus = 'success' | 'failure' | 'running' | 'waiting'

export type SessionPullRequestFacts = SessionPullRequestRef & {
  title: string
  url: string
  state: SessionPullRequestState
  approved: boolean
  reviewDecision?: 'approved' | 'changes-requested' | 'review-required' | null
  headCommit?: string | null
  checks: CheckStatus
  failingChecks: number
  baseBranch: string
  mergeCommit: string | null
  mergedAt: number | null
  /** When it was merged or closed; null while open. */
  settledAt: number | null
  deploy: {
    /** Deploy workflows that run on the base branch; empty when it deploys nowhere. */
    workflows: string[]
    /** Null until the pull request is merged. */
    status: SessionDeployStatus | null
    url: string | null
  }
}

/** One workflow run on the base branch, as `gh api …/actions/runs` reports it. */
export type SessionWorkflowRun = {
  name: string
  status: string
  conclusion: string | null
  headSha: string
  url: string
  createdAt: number
}

/** GitHub's owner/repo alphabet; a name of only dots could climb out of the API path. */
const OWNER_REPO = /^(?!\.+$)[A-Za-z0-9_.-]{1,100}$/
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
  'error'
])
/** Workflows whose name says they deploy ("Deploy to Production", "Deploy Betacorp"). */
const DEPLOY_WORKFLOW = /\bdeploy/i
/** A run created this long before `mergedAt` can still carry the merge (clock skew). */
const MERGE_SKEW_MS = 60_000

export function isSessionPullRequestRef(value: unknown): value is SessionPullRequestRef {
  if (!value || typeof value !== 'object') {
    return false
  }
  const ref = value as Record<string, unknown>
  return (
    typeof ref.owner === 'string' &&
    OWNER_REPO.test(ref.owner) &&
    typeof ref.repo === 'string' &&
    OWNER_REPO.test(ref.repo) &&
    Number.isInteger(ref.number) &&
    (ref.number as number) > 0
  )
}

export function sessionPullRequestKey(ref: SessionPullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function time(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function failingCount(rollup: unknown): number {
  if (!Array.isArray(rollup)) {
    return 0
  }
  return rollup.filter((raw) => {
    const check = (raw ?? {}) as Record<string, unknown>
    const conclusion = text(check.conclusion).toLowerCase()
    const state = text(check.state).toLowerCase()
    return FAILING_CONCLUSIONS.has(conclusion) || state === 'failure' || state === 'error'
  }).length
}

/** `gh pr view --json number,title,url,state,isDraft,reviewDecision,…` → facts, deploy unset. */
export function parseSessionPullRequestView(
  ref: SessionPullRequestRef,
  json: unknown
): Omit<SessionPullRequestFacts, 'deploy'> | null {
  if (!json || typeof json !== 'object') {
    return null
  }
  const view = json as Record<string, unknown>
  const rawState = text(view.state).toUpperCase()
  const state: SessionPullRequestState =
    rawState === 'MERGED'
      ? 'merged'
      : rawState === 'CLOSED'
        ? 'closed'
        : view.isDraft === true
          ? 'draft'
          : 'open'
  const mergeCommit = text((view.mergeCommit as Record<string, unknown> | null)?.oid) || null
  return {
    ...ref,
    title: text(view.title),
    url: text(view.url) || `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    state,
    approved: text(view.reviewDecision).toUpperCase() === 'APPROVED',
    reviewDecision:
      text(view.reviewDecision).toUpperCase() === 'CHANGES_REQUESTED'
        ? 'changes-requested'
        : text(view.reviewDecision).toUpperCase() === 'REVIEW_REQUIRED'
          ? 'review-required'
          : text(view.reviewDecision).toUpperCase() === 'APPROVED'
            ? 'approved'
            : null,
    headCommit: text(view.headRefOid) || null,
    checks: derivePRCheckStatusFromRollup(view.statusCheckRollup),
    failingChecks: failingCount(view.statusCheckRollup),
    baseBranch: text(view.baseRefName),
    mergeCommit,
    mergedAt: time(view.mergedAt),
    settledAt: time(view.mergedAt) ?? time(view.closedAt)
  }
}

/** `gh api …/actions/runs --jq '[.workflow_runs[] | {…}]'` → the deploy runs, newest first. */
export function parseSessionDeployRuns(json: unknown): SessionWorkflowRun[] {
  if (!Array.isArray(json)) {
    return []
  }
  return json
    .map((raw) => {
      const run = (raw ?? {}) as Record<string, unknown>
      return {
        name: text(run.name),
        status: text(run.status).toLowerCase(),
        conclusion: text(run.conclusion).toLowerCase() || null,
        headSha: text(run.head_sha).toLowerCase(),
        url: text(run.html_url),
        createdAt: time(run.created_at) ?? 0
      }
    })
    .filter((run) => DEPLOY_WORKFLOW.test(run.name) && run.headSha)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function deployWorkflowNames(runs: readonly SessionWorkflowRun[]): string[] {
  return [...new Set(runs.map((run) => run.name))]
}

/**
 * Runs that could carry the merge: started at or after it. The caller confirms the newest one
 * whose head is not the merge commit itself (a later push also deploys the merge).
 */
export function deployCandidates(
  runs: readonly SessionWorkflowRun[],
  mergedAt: number
): SessionWorkflowRun[] {
  return runs.filter((run) => run.createdAt >= mergedAt - MERGE_SKEW_MS)
}

export function deployRunStatus(run: SessionWorkflowRun): SessionDeployStatus {
  if (run.status !== 'completed') {
    return 'running'
  }
  return run.conclusion === 'success' ? 'success' : 'failure'
}

/** Nothing about it changes without a new push: closed, or merged and deployed (or undeployable). */
export function isSettledSessionPullRequest(facts: SessionPullRequestFacts): boolean {
  if (facts.state === 'closed') {
    return true
  }
  if (facts.state !== 'merged') {
    return false
  }
  return (
    facts.deploy.workflows.length === 0 ||
    facts.deploy.status === 'success' ||
    facts.deploy.status === 'failure'
  )
}
