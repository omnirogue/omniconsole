import { isDeepStrictEqual } from 'node:util'
import { GITHUB_MERGE_EXPECTED_HEAD_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { parseGitHubRemoteIdentity } from '../github/github-remote-identity-parsing'
import { randomUUID } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeWorkflowTarget } from './session-outcome-workflow-target'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import {
  verifyGitHubReviewAdmission,
  readMergedGitHubReview,
  GitHubReviewReadbackError,
  type VerifiedGitHubReviewAdmission
} from '../console-workflows/console-github-review-readback'
import type { SessionOutcomeService } from './session-outcome-service'

/** A persisted host operation invokes the existing guarded GitHub transport once, then only rereads. */
export async function publishSessionOutcomeMerge(
  service: SessionOutcomeService,
  initial: SessionChain,
  outcomeId: string
): Promise<SessionChain> {
  let chain = initial
  let set = chain.outcomeSet!
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)!
  const condition = outcome.conditions.find((entry) => entry.kind === 'merge')
  if (!condition || outcome.finish !== 'merge') {
    return chain
  }
  const current = sessionOutcomeWorkflowTarget(chain, condition, outcomeId)
  const reviews = current.reviews.map((entry) => entry.receipt)
  if (!reviews.length || !condition.targetBranch) {
    throw new Error('Merge requires independent accepted reviewers and the saved target branch.')
  }
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(
    current.receipt.prUrl!
  )
  if (!match) {
    throw new Error('The accepted result does not identify a supported GitHub pull request.')
  }
  const repo = match[1]!,
    prNumber = Number(match[2])
  const producingNode = current.workflow.preview.graph.nodes.find(
    (node) => node.key === current.receipt.key
  )
  const frozenRepo = producingNode?.repo ?? ''
  const origin = parseGitHubRemoteIdentity(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(frozenRepo)
      ? `https://github.com/${frozenRepo}`
      : frozenRepo
  )
  if (
    !origin ||
    origin.host !== 'github.com' ||
    `${origin.owner}/${origin.repo}`.toLowerCase() !== repo.toLowerCase() ||
    producingNode?.base_branch !== condition.targetBranch
  ) {
    throw new Error('The accepted candidate differs from its frozen repository or destination.')
  }
  const expectedRoster = current.expectedReviewerIds
  if (
    reviews.some(
      (review) =>
        review.verdict?.verdict !== 'agree' ||
        review.verdict.blockers.length ||
        review.verdict.gaps.length ||
        review.candidateSha !== current.receipt.candidateSha ||
        !review.verdict.notes.includes(current.receipt.candidateSha!)
    )
  ) {
    throw new Error('The accepted review set no longer proves this exact candidate.')
  }
  const acceptedReviews = current.reviews.map(({ receipt: review, reviewerId }) => ({
    artifactId: `${review.jobId}:runner_result_receipt:${review.eventId}`,
    artifactVersion: `${review.attempt}:${review.leaseGeneration}:${review.fingerprint}`,
    reviewerId,
    verdict: 'accepted' as const,
    producerGitSha: current.receipt.candidateSha!,
    repo,
    prNumber,
    headRef: current.receipt.branch!,
    baseRef: condition.targetBranch!,
    headSha: review.candidateSha!
  }))
  const normalizedReviews = (rows: typeof acceptedReviews) =>
    [...rows].sort((a, b) =>
      a.reviewerId < b.reviewerId ? -1 : a.reviewerId > b.reviewerId ? 1 : 0
    )
  const priorOperations =
    set.publications?.filter(
      (entry) => entry.outcomeId === outcomeId && entry.conditionId === condition.id
    ) ?? []
  let operation = priorOperations.findLast(
    (entry) =>
      entry.admission.review.headSha === current.receipt.candidateSha &&
      entry.admission.review.headRef === current.receipt.branch &&
      entry.admission.review.baseRef === condition.targetBranch &&
      entry.admission.review.repo === repo &&
      entry.admission.review.prNumber === prNumber &&
      isDeepStrictEqual(
        normalizedReviews(entry.admission.acceptedReviews),
        normalizedReviews(acceptedReviews)
      )
  )
  const save = () => {
    chain = service.save({ ...chain, outcomeSet: set }, set.revision)
    set = chain.outcomeSet!
  }
  if (!operation) {
    for (const prior of priorOperations.filter((entry) => entry.state === 'requested')) {
      let observed
      try {
        observed = await readMergedGitHubReview(prior.admission)
      } catch (error) {
        if (error instanceof GitHubReviewReadbackError && error.code === 'not-merged') {
          throw new Error(
            'Reconcile the previous merge request before publishing an amended review set.'
          )
        }
        throw error
      }
      set = {
        ...set,
        publications: set.publications!.map((entry) =>
          entry.id === prior.id
            ? { ...entry, state: 'merged', mergeCommitSha: observed.review.mergeCommitSha! }
            : entry
        )
      }
      save()
    }
  }
  if (!operation) {
    const admitted = await verifyGitHubReviewAdmission({
      repo,
      prNumber,
      headRef: current.receipt.branch!,
      expectedBaseRef: condition.targetBranch,
      producerGitSha: current.receipt.candidateSha!,
      expectedReviewerIds: expectedRoster,
      acceptedReviews
    })
    operation = {
      id: randomUUID(),
      outcomeId,
      conditionId: condition.id,
      state: 'prepared',
      admission: admitted
    }
    set = { ...set, publications: [...(set.publications ?? []), operation] }
    save()
  }
  if (
    operation.admission.review.headSha !== current.receipt.candidateSha ||
    operation.admission.review.headRef !== current.receipt.branch ||
    operation.admission.review.baseRef !== condition.targetBranch
  ) {
    throw new Error('The retained merge intent belongs to another candidate or destination.')
  }
  const admitted: VerifiedGitHubReviewAdmission = operation.admission
  let refusal: string | undefined = operation.state === 'blocked' ? operation.error : undefined
  if (operation.state === 'prepared' && admitted.review.state !== 'merged') {
    if ((await readSessionOutcomePrincipal()) !== set.continuation.principal) {
      throw new Error('The signed person changed before merge.')
    }
    // Same execution host only. Remote runtimes must negotiate github.mergePR.expected-head.v1;
    // this native direct call never routes to an older remote implementation.
    const workspace = await service.runtime.showManagedTerminalWorkspace(`id:${chain.worktreeId}`)
    const selectedRepo = await service.runtime.showRepo(workspace.repoId)
    if (
      condition.repository &&
      (await service.runtime.showRepo(condition.repository)).id !== selectedRepo.id
    ) {
      throw new Error('The saved merge repository differs from the selected execution repository.')
    }
    if (
      selectedRepo.connectionId ||
      (selectedRepo.executionHostId && selectedRepo.executionHostId !== 'local')
    ) {
      throw new Error('Guarded publication requires the owning local runtime.')
    }
    if (
      !service.runtime
        .getStatus()
        .capabilities?.includes(GITHUB_MERGE_EXPECTED_HEAD_RUNTIME_CAPABILITY)
    ) {
      throw new Error('The owning runtime does not support an atomic expected-head merge.')
    }
    operation = { ...operation, state: 'requested' }
    set = {
      ...set,
      publications: set.publications!.map((entry) =>
        entry.id === operation!.id ? operation! : entry
      )
    }
    save()
    const [owner, name] = repo.split('/')
    // Required GitHub protection and exact-head handling stay in the existing product operation.
    const result = await service.runtime.mergeRepoPR(
      workspace.repoId,
      prNumber,
      undefined,
      { owner: owner!, repo: name! },
      admitted.review.headSha
    )
    if (!result.ok) {
      refusal = result.error ?? 'GitHub refused the guarded merge.'
    }
  }
  let merged
  try {
    merged = await readMergedGitHubReview(admitted)
  } catch (error) {
    if (error instanceof GitHubReviewReadbackError && error.code === 'not-merged') {
      if (refusal) {
        set = {
          ...set,
          publications: set.publications!.map((entry) =>
            entry.id === operation!.id ? { ...entry, state: 'blocked', error: refusal } : entry
          )
        }
        save()
        throw new Error(refusal)
      }
      return chain
    }
    throw error
  }
  const receipt = `${merged.review.url}@${merged.review.headSha}:merged:${merged.review.mergeCommitSha}:base:${merged.review.baseRef}`
  set = recordSessionOutcomeEvidence(
    set,
    sessionOutcomeVerifiedEvidence(outcome, condition, receipt, Date.now(), merged.review.headSha)
  )
  set = {
    ...set,
    publications: set.publications!.map((entry) =>
      entry.id === operation!.id
        ? { ...entry, state: 'merged', mergeCommitSha: merged.review.mergeCommitSha }
        : entry
    )
  }
  save()
  return chain
}
