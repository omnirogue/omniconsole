import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { SpecPrBatch, SpecPrBatchSlot } from '../../shared/spec-pr-batch'
import { gitExecFileAsync } from '../git/runner'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

export function isVerifiedSpecDraft(
  review: HostedReviewInfo | null,
  slot: SpecPrBatchSlot,
  head: string
): review is HostedReviewInfo {
  const expectedRepo = slot.repoRemote.replace(/^github\.com\//i, '').toLowerCase()
  const actualRepo = review?.githubRepository
    ? `${review.githubRepository.owner}/${review.githubRepository.repo}`.toLowerCase()
    : ''
  return (
    review?.provider === 'github' &&
    review.state === 'draft' &&
    review.baseRefName === slot.baseRef &&
    review.headSha === head &&
    actualRepo === expectedRepo
  )
}

export async function refreshSpecPrBatch(
  runtime: OrcaRuntimeService,
  batch: SpecPrBatch,
  save: (batch: SpecPrBatch) => void,
  isStopped: () => boolean
): Promise<SpecPrBatch> {
  for (const slot of batch.slots) {
    if (!slot.dispatchId || !slot.worktreeId) {
      continue
    }
    try {
      const worker = runtime.getOrchestrationDb().getWorkerDispatch(slot.dispatchId)
      if (!worker) {
        slot.phase = 'unverifiable'
        slot.reason = 'Worker dispatch is unavailable.'
        continue
      }
      if (worker.state === 'start_unknown' || worker.state === 'stop_unknown') {
        slot.phase = 'unverifiable'
        slot.reason = 'Worker outcome needs reconciliation.'
        continue
      }
      if (
        !slot.prNumber &&
        (worker.state === 'failed' || worker.state === 'stopped' || worker.state === 'abandoned')
      ) {
        slot.phase = 'failed'
        slot.reason = worker.last_error ?? 'The builder did not complete.'
        continue
      }
      if (!slot.branch || (worker.state !== 'succeeded' && !slot.prNumber)) {
        continue
      }
      const workspace = await runtime.showManagedTerminalWorkspace(`id:${slot.worktreeId}`)
      const cwd = workspace.git.path
      const head = (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
      let review = await runtime.getHostedReviewForBranch({
        repoSelector: slot.repoId,
        branch: slot.branch,
        currentHeadOid: head,
        active: true
      })
      if (!review && (slot.prCreateAttempted || slot.prNumber)) {
        slot.phase = 'unverifiable'
        slot.reason = 'Draft PR creation was attempted; provider readback is still unavailable.'
        continue
      }
      if (!review && !isStopped()) {
        const status = await runtime.getArtifactReviewStatus({ slug: slot.artifactSlug })
        if (
          status.status !== 'ok' ||
          status.value.status !== 'approved' ||
          status.value.latest?.id !== slot.decisionId ||
          status.value.artifact.revision !== slot.revision
        ) {
          slot.phase = 'waiting'
          slot.reason = 'Approval changed before draft PR creation.'
          continue
        }
        if (isStopped()) {
          slot.phase = 'waiting'
          slot.reason = 'The batch was stopped before draft PR creation.'
          continue
        }
        const dirty = (await gitExecFileAsync(['status', '--porcelain=v1'], { cwd })).stdout
        const pushed = (
          await gitExecFileAsync(['ls-remote', '--heads', 'origin', slot.branch], { cwd })
        ).stdout.trim()
        if (
          dirty ||
          head === slot.baseOid ||
          !pushed.startsWith(`${head}\trefs/heads/${slot.branch}`)
        ) {
          slot.phase = 'waiting'
          slot.reason = 'Commit and push a clean, nonempty branch before creating the PR.'
          continue
        }
        slot.prCreateAttempted = true
        slot.phase = 'verifying'
        save(batch)
        const created = await runtime.createHostedReview({
          repoSelector: slot.repoId,
          worktreeSelector: `id:${slot.worktreeId}`,
          provider: 'github',
          base: slot.baseRef,
          head: slot.branch,
          title: slot.title,
          draft: true,
          body: `Approved spec: ${status.value.shareUrl}\nRevision: ${slot.revision}\nDecision: ${slot.decisionId}\nBatch: ${batch.id}`
        })
        review = await runtime.getHostedReviewForBranch({
          repoSelector: slot.repoId,
          branch: slot.branch,
          currentHeadOid: head,
          active: true
        })
        if (!review) {
          slot.phase = 'unverifiable'
          slot.reason = created.ok
            ? 'Draft PR creation needs provider readback; it will not be repeated automatically.'
            : `Draft PR creation returned ${created.code}; provider readback is required before retry.`
          continue
        }
      }
      if (isVerifiedSpecDraft(review, slot, head)) {
        slot.prNumber = review.number
        slot.prUrl = review.url
        slot.phase = 'draft_pr_open'
        slot.reason = undefined
      } else {
        slot.phase = 'waiting'
        slot.reason = 'Builder finished; a matching draft PR has not been verified.'
      }
    } catch {
      slot.phase = 'unverifiable'
      slot.reason = 'The execution host or GitHub review could not be verified.'
    }
  }
  save(batch)
  return batch
}
