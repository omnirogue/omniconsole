import { readConsoleJobCandidate } from './console-job-candidate'
import { gitPush } from '../git/remote'
import { createHostedReview } from '../source-control/hosted-review-creation'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { hostedReviewProviderSupportsDraft } from '../../shared/hosted-review'
import { detectHostedReviewProvider } from '../source-control/forge-provider'
import { consoleJobOutputDigest } from './console-job-acceptance'
import type { ConsoleLocalJob, ConsoleLocalResult } from './console-local-execution-contract'

const reviewServices = { gitPush, createHostedReview, getHostedReviewForBranch }

export async function publishConsoleJobReview(
  job: ConsoleLocalJob,
  cwd: string,
  result: ConsoleLocalResult,
  services = reviewServices
): Promise<ConsoleLocalResult> {
  if (
    result.status !== 'done' ||
    job.readOnly ||
    job.workspace?.kind === 'folder' ||
    job.artifactResult
  ) {
    return result
  }
  if (!job.baseBranch || !result.branch) {
    throw new Error('Git review publication requires the admitted base and candidate branch.')
  }
  if (result.output_digest !== consoleJobOutputDigest(result)) {
    throw new Error('The acceptance result digest no longer matches its evidence.')
  }
  const assertCandidate = async () => {
    const candidate = await readConsoleJobCandidate(cwd)
    if (!candidate.committed) {
      throw new Error('Acceptance passed, but changes must be committed before publication.')
    }
    if (candidate.head !== result.candidate_sha || candidate.branch !== result.branch) {
      throw new Error('The candidate HEAD or branch no longer matches the accepted result.')
    }
  }
  await assertCandidate()
  const provider = job.reviewProvider ?? (await detectHostedReviewProvider({ repoPath: cwd }))
  if (provider === 'unsupported') {
    throw new Error('The job repository has no supported review provider.')
  }
  if (job.revision) {
    const review = await services.getHostedReviewForBranch({
      repoPath: cwd,
      branch: result.branch,
      active: true
    })
    if (
      !review ||
      review.url !== job.revision.reviewUrl ||
      review.number !== job.revision.reviewNumber ||
      !['open', 'draft'].includes(review.state)
    ) {
      throw new Error('The confirmed revision no longer resolves to the same open review request.')
    }
    await assertCandidate()
    await services.gitPush(cwd)
    await assertCandidate()
    const completed: ConsoleLocalResult = {
      ...result,
      status: 'pr_open',
      pr_url: review.url,
      pr_number: review.number
    }
    return { ...completed, output_digest: consoleJobOutputDigest(completed) }
  }
  await assertCandidate()
  await services.gitPush(cwd)
  await assertCandidate()
  const review = await services.createHostedReview(cwd, {
    provider,
    base: job.baseBranch,
    head: result.branch,
    title: job.title,
    body: `${job.brief}\n\nAcceptance:\n${job.acceptance}\n\n${result.output_tail}`,
    worktreePath: cwd,
    draft: hostedReviewProviderSupportsDraft(provider)
  })
  const linked = review.ok
    ? review
    : review.code === 'already_exists'
      ? review.existingReview
      : undefined
  if (!linked?.number) {
    throw new Error(review.ok ? 'The review receipt is missing its number.' : review.error)
  }
  await assertCandidate()
  const completed: ConsoleLocalResult = {
    ...result,
    status: 'pr_open',
    pr_url: linked.url,
    pr_number: linked.number
  }
  return { ...completed, output_digest: consoleJobOutputDigest(completed) }
}
