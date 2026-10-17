import { ghExecFileAsync } from './gh-utils'
import {
  deployCandidates,
  deployRunStatus,
  deployWorkflowNames,
  isSessionPullRequestRef,
  parseSessionDeployRuns,
  parseSessionPullRequestView,
  sessionPullRequestKey,
  type SessionPullRequestFacts,
  type SessionPullRequestRef,
  type SessionWorkflowRun
} from '../../shared/session-pull-request-facts'

// Read-only GitHub facts for the session card's milestones: one `gh pr view`, one deploy-run list
// per base branch (shared by that branch's PRs), and a commit comparison only when the newest
// deploy's head is not the merge commit itself. Nothing here writes to GitHub.

const VIEW_FIELDS =
  'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,baseRefName,headRefOid,mergeCommit,mergedAt,closedAt'
const RUNS_JQ = '[.workflow_runs[] | {name, status, conclusion, head_sha, html_url, created_at}]'
const FACTS_TTL_MS = 30_000
const RUNS_TTL_MS = 2 * 60_000
const CACHE_MAX = 200
const SHA = /^[0-9a-f]{7,64}$/

type Timed<T> = { value: T; at: number }

const factsCache = new Map<string, Timed<SessionPullRequestFacts | null>>()
const runsCache = new Map<string, Timed<SessionWorkflowRun[]>>()
/** Whether a deploy head contains a merge commit; immutable once known. */
const containsCache = new Map<string, boolean>()
const inflight = new Map<string, Promise<SessionPullRequestFacts | null>>()

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.delete(oldest)
    }
  }
}

function fresh<T>(entry: Timed<T> | undefined, ttl: number): entry is Timed<T> {
  return entry !== undefined && Date.now() - entry.at < ttl
}

async function ghJson(args: string[]): Promise<unknown> {
  const { stdout } = await ghExecFileAsync(args, { idempotent: true })
  return JSON.parse(stdout) as unknown
}

async function branchDeployRuns(
  ref: SessionPullRequestRef,
  branch: string
): Promise<SessionWorkflowRun[]> {
  const key = `${ref.owner}/${ref.repo}:${branch}`.toLowerCase()
  const cached = runsCache.get(key)
  if (fresh(cached, RUNS_TTL_MS)) {
    return cached.value
  }
  const path = `repos/${ref.owner}/${ref.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30`
  const runs = parseSessionDeployRuns(await ghJson(['api', path, '--jq', RUNS_JQ]))
  remember(runsCache, key, { value: runs, at: Date.now() })
  return runs
}

async function headContainsMerge(
  ref: SessionPullRequestRef,
  merge: string,
  head: string
): Promise<boolean> {
  if (head === merge) {
    return true
  }
  if (!SHA.test(merge) || !SHA.test(head)) {
    return false
  }
  const key = `${ref.owner}/${ref.repo}:${merge}...${head}`.toLowerCase()
  const known = containsCache.get(key)
  if (known !== undefined) {
    return known
  }
  const path = `repos/${ref.owner}/${ref.repo}/compare/${merge}...${head}`
  const compared = (await ghJson(['api', path, '--jq', '{status: .status}'])) as {
    status?: unknown
  }
  // Why: "ahead" or "identical" means the deployed head already holds the merge.
  const contains = compared?.status === 'ahead' || compared?.status === 'identical'
  remember(containsCache, key, contains)
  return contains
}

async function deployFacts(
  ref: SessionPullRequestRef,
  view: Omit<SessionPullRequestFacts, 'deploy'>
): Promise<SessionPullRequestFacts['deploy']> {
  const runs = view.baseBranch ? await branchDeployRuns(ref, view.baseBranch) : []
  const workflows = deployWorkflowNames(runs)
  const merge = view.mergeCommit?.toLowerCase() ?? null
  if (view.state !== 'merged' || !merge || view.mergedAt === null || workflows.length === 0) {
    return { workflows, status: null, url: null }
  }
  const candidates = deployCandidates(runs, view.mergedAt)
  const newest = candidates[0]
  const carrying = candidates.filter((run) => run.headSha === merge)
  if (newest && newest.headSha !== merge && (await headContainsMerge(ref, merge, newest.headSha))) {
    carrying.unshift(newest)
  }
  // Why: once any run carrying the merge succeeded, the merge is live even if a later one failed.
  const live = carrying.find((run) => deployRunStatus(run) === 'success')
  const latest = live ?? carrying[0]
  return {
    workflows,
    status: latest ? deployRunStatus(latest) : 'waiting',
    url: latest?.url || null
  }
}

async function readFacts(ref: SessionPullRequestRef): Promise<SessionPullRequestFacts | null> {
  const view = parseSessionPullRequestView(
    ref,
    await ghJson([
      'pr',
      'view',
      String(ref.number),
      '-R',
      `${ref.owner}/${ref.repo}`,
      '--json',
      VIEW_FIELDS
    ])
  )
  if (!view) {
    return null
  }
  const deploy = await deployFacts(ref, view).catch(() => ({
    workflows: [],
    status: null,
    url: null
  }))
  return { ...view, deploy }
}

/**
 * A session pull request's state, approval, checks and deploy, or null when GitHub cannot say
 * (no access, rate limit, deleted repo). Cached for 30 s; concurrent asks share one read.
 */
export async function readSessionPullRequestFacts(
  ref: unknown
): Promise<SessionPullRequestFacts | null> {
  if (!isSessionPullRequestRef(ref)) {
    throw new Error('Expected { owner, repo, number } for a GitHub pull request.')
  }
  const key = sessionPullRequestKey(ref)
  const cached = factsCache.get(key)
  if (fresh(cached, FACTS_TTL_MS)) {
    return cached.value
  }
  const pending = inflight.get(key)
  if (pending) {
    return pending
  }
  const read = readFacts(ref)
    .catch(() => null)
    .then((facts) => {
      remember(factsCache, key, { value: facts, at: Date.now() })
      return facts
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, read)
  return read
}

export function resetSessionPullRequestFactsCacheForTest(): void {
  factsCache.clear()
  runsCache.clear()
  containsCache.clear()
  inflight.clear()
}
