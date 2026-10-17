import { ghExecFileAsync } from '../git/runner'
import { classifyGhError } from '../github/gh-utils'

export type CanonicalAcceptedReviewBinding = {
  artifactId: string
  artifactVersion: string
  reviewerId: string
  verdict: 'accepted'
  producerGitSha: string
  repo: string
  prNumber: number
  headRef: string
  baseRef: string
  headSha: string
}

export type GitHubReviewSnapshot = {
  repo: string
  prNumber: number
  url: string
  state: 'open' | 'closed' | 'merged'
  headRef: string
  baseRef: string
  headSha: string
  mergeCommitSha: string | null
}

export type VerifiedGitHubReviewAdmission = {
  provider: 'github'
  review: GitHubReviewSnapshot
  producerGitSha: string
  acceptedReviews: CanonicalAcceptedReviewBinding[]
}

export type VerifiedGitHubMergedReview = VerifiedGitHubReviewAdmission & {
  review: GitHubReviewSnapshot & { state: 'merged'; mergeCommitSha: string }
}

export type GitHubReviewReadbackErrorCode =
  | 'provider-failed'
  | 'review-not-found'
  | 'review-identity-mismatch'
  | 'head-changed'
  | 'review-binding-invalid'
  | 'review-binding-replayed'
  | 'review-roster-mismatch'
  | 'not-merged'
  | 'merge-commit-missing'

export class GitHubReviewReadbackError extends Error {
  constructor(
    readonly code: GitHubReviewReadbackErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'GitHubReviewReadbackError'
  }
}

function fail(code: GitHubReviewReadbackErrorCode, message: string, cause?: unknown): never {
  throw new GitHubReviewReadbackError(code, message, cause)
}

type ReadGitHubReview = (repo: string, prNumber: number) => Promise<GitHubReviewSnapshot | null>

type AdmissionInput = {
  repo: string
  prNumber: number
  headRef: string
  expectedBaseRef: string
  producerGitSha: string
  acceptedReviews: CanonicalAcceptedReviewBinding[]
  expectedReviewerIds: string[]
}

type GitHubPullRequestJson = {
  number?: unknown
  state?: unknown
  url?: unknown
  headRefName?: unknown
  baseRefName?: unknown
  headRefOid?: unknown
  mergeCommit?: { oid?: unknown } | null
}

function normalizedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeState(value: unknown): GitHubReviewSnapshot['state'] | null {
  const state = normalizedText(value)?.toLowerCase()
  return state === 'open' || state === 'closed' || state === 'merged' ? state : null
}

export function normalizeGitHubReviewSnapshot(
  repo: string,
  prNumber: number,
  raw: GitHubPullRequestJson
): GitHubReviewSnapshot {
  const state = normalizeState(raw.state)
  const url = normalizedText(raw.url)
  const headRef = normalizedText(raw.headRefName)
  const baseRef = normalizedText(raw.baseRefName)
  const headSha = normalizedText(raw.headRefOid)
  let parsedUrl: URL | null = null
  try {
    parsedUrl = url ? new URL(url) : null
  } catch {
    parsedUrl = null
  }
  const expectedPath = `/${repo}/pull/${prNumber}`.toLowerCase()
  if (
    raw.number !== prNumber ||
    !state ||
    !url ||
    !headRef ||
    !baseRef ||
    !headSha ||
    parsedUrl?.hostname.toLowerCase() !== 'github.com' ||
    parsedUrl.pathname.toLowerCase() !== expectedPath
  ) {
    fail(
      'review-identity-mismatch',
      'GitHub returned a different or incomplete pull request identity.'
    )
  }
  return {
    repo,
    prNumber,
    url,
    state,
    headRef,
    baseRef,
    headSha,
    mergeCommitSha: normalizedText(raw.mergeCommit?.oid)
  }
}

async function readGitHubReview(
  repo: string,
  prNumber: number
): Promise<GitHubReviewSnapshot | null> {
  try {
    const { stdout } = await ghExecFileAsync([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'number,state,url,headRefName,baseRefName,headRefOid,mergeCommit'
    ])
    return normalizeGitHubReviewSnapshot(
      repo,
      prNumber,
      JSON.parse(stdout) as GitHubPullRequestJson
    )
  } catch (error) {
    if (error instanceof GitHubReviewReadbackError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    if (classifyGhError(message).type === 'not_found') {
      return null
    }
    fail('provider-failed', 'GitHub pull request readback failed.', error)
  }
}

// The adapter authenticates canonical artifacts and proves accepted verdicts, zero blockers,
// and model/job provenance. This helper only binds those verified references to provider state.
function validateBindings(input: AdmissionInput): CanonicalAcceptedReviewBinding[] {
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(input.repo) ||
    !Number.isInteger(input.prNumber) ||
    input.prNumber < 1 ||
    !normalizedText(input.headRef) ||
    !normalizedText(input.expectedBaseRef) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.producerGitSha)
  ) {
    fail('review-binding-invalid', 'The admitted pull request binding is malformed.')
  }
  if (input.acceptedReviews.length === 0) {
    fail('review-binding-invalid', 'No accepted review artifacts were provided.')
  }
  const expectedReviewers = input.expectedReviewerIds.map(normalizedText)
  if (
    expectedReviewers.length === 0 ||
    expectedReviewers.some((reviewerId) => !reviewerId) ||
    new Set(expectedReviewers).size !== expectedReviewers.length
  ) {
    fail(
      'review-roster-mismatch',
      'The expected reviewer roster must contain unique reviewer identities.'
    )
  }
  const seen = new Set<string>()
  const seenReviewers = new Set<string>()
  for (const binding of input.acceptedReviews) {
    if (
      !normalizedText(binding.artifactId) ||
      !normalizedText(binding.artifactVersion) ||
      !normalizedText(binding.reviewerId) ||
      binding.verdict !== 'accepted' ||
      binding.producerGitSha !== input.producerGitSha ||
      binding.repo !== input.repo ||
      binding.prNumber !== input.prNumber ||
      binding.headRef !== input.headRef ||
      binding.baseRef !== input.expectedBaseRef ||
      binding.headSha !== input.producerGitSha
    ) {
      fail(
        'review-binding-invalid',
        'An accepted review artifact is not bound to the admitted pull request head.'
      )
    }
    const key = `${binding.artifactId}\0${binding.artifactVersion}`
    if (seen.has(key)) {
      fail(
        'review-binding-replayed',
        'The same accepted review artifact was supplied more than once.'
      )
    }
    seen.add(key)
    if (seenReviewers.has(binding.reviewerId)) {
      fail('review-binding-replayed', 'A reviewer supplied more than one accepted review artifact.')
    }
    seenReviewers.add(binding.reviewerId)
  }
  if (
    seenReviewers.size !== expectedReviewers.length ||
    expectedReviewers.some((reviewerId) => !seenReviewers.has(reviewerId!))
  ) {
    fail(
      'review-roster-mismatch',
      'Accepted review artifacts do not exactly satisfy the expected reviewer roster.'
    )
  }
  return input.acceptedReviews.map((binding) => ({ ...binding }))
}

export async function verifyGitHubReviewAdmission(
  input: AdmissionInput,
  read: ReadGitHubReview = readGitHubReview
): Promise<VerifiedGitHubReviewAdmission> {
  const acceptedReviews = validateBindings(input)
  const review = await read(input.repo, input.prNumber)
  if (!review) {
    fail('review-not-found', 'GitHub did not return the admitted pull request.')
  }
  if (
    review.repo !== input.repo ||
    review.prNumber !== input.prNumber ||
    review.headRef !== input.headRef ||
    review.baseRef !== input.expectedBaseRef
  ) {
    fail('review-identity-mismatch', 'GitHub returned a different pull request source identity.')
  }
  if (review.headSha !== input.producerGitSha) {
    fail('head-changed', 'The pull request head changed after review acceptance.')
  }
  return { provider: 'github', review, producerGitSha: input.producerGitSha, acceptedReviews }
}

export async function readMergedGitHubReview(
  admitted: VerifiedGitHubReviewAdmission,
  read: ReadGitHubReview = readGitHubReview
): Promise<VerifiedGitHubMergedReview> {
  const current = await read(admitted.review.repo, admitted.review.prNumber)
  if (!current) {
    fail('review-not-found', 'GitHub did not return the admitted pull request.')
  }
  if (
    current.repo !== admitted.review.repo ||
    current.prNumber !== admitted.review.prNumber ||
    current.headRef !== admitted.review.headRef ||
    current.baseRef !== admitted.review.baseRef
  ) {
    fail('review-identity-mismatch', 'GitHub returned a different pull request source identity.')
  }
  if (current.headSha !== admitted.producerGitSha) {
    fail('head-changed', 'The merged pull request head differs from the reviewed candidate.')
  }
  if (current.state !== 'merged') {
    fail('not-merged', 'GitHub has not reported the pull request as merged.')
  }
  if (!current.mergeCommitSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(current.mergeCommitSha)) {
    fail('merge-commit-missing', 'GitHub reported merged without a valid merge commit.')
  }
  return {
    ...admitted,
    review: { ...current, state: 'merged', mergeCommitSha: current.mergeCommitSha }
  }
}
