import { join } from 'node:path'
import {
  implementationApprovalCoversTarget,
  type SpecPrBatch,
  type SpecPrBatchSlot,
  type SpecPrBatchStart
} from '../../shared/spec-pr-batch'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { gitExecFileAsync } from '../git/runner'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { specSourceDigest } from './spec-pr-batch-store'

export async function prepareSpecPrBatchSlots(
  runtime: OrcaRuntimeService,
  request: SpecPrBatchStart,
  scope: { principal: string; directory: string },
  id: string,
  assertPrincipal: () => void
): Promise<SpecPrBatch['slots']> {
  const slots = [] as SpecPrBatchSlot[]
  for (const [index, target] of request.targets.entries()) {
    const review = await runtime.getArtifactReviewStatus({ slug: target.artifactSlug })
    if (review.status !== 'ok') {
      throw new Error(`Spec ${index + 1}: review status is unavailable.`)
    }
    const status = review.value
    if (
      status.status !== 'approved' ||
      status.latest?.decision !== 'approved' ||
      status.latest.id !== target.decisionId ||
      status.latest.revision !== target.revision ||
      status.artifact.revision !== target.revision ||
      status.supersededBy ||
      status.artifact.supersededBy ||
      status.lifecycle ||
      status.artifact.lifecycle
    ) {
      throw new Error(`Spec ${index + 1}: the exact current review is not open and approved.`)
    }
    if (!['text/markdown', 'text/plain'].includes(status.artifact.sourceContentType)) {
      throw new Error(`Spec ${index + 1}: select a Markdown or text spec.`)
    }
    const repo = await runtime.showRepo(target.repoId)
    if (
      repo.kind === 'folder' ||
      repo.connectionId ||
      (repo.executionHostId && repo.executionHostId !== 'local')
    ) {
      throw new Error(`Spec ${index + 1}: select a local registered Git repository.`)
    }
    const remote = (
      await gitExecFileAsync(['remote', 'get-url', 'origin'], { cwd: repo.path })
    ).stdout.trim()
    const identity = normalizeGitRemoteUrl(remote)
    if (!identity?.toLowerCase().startsWith('github.com/')) {
      throw new Error(`Spec ${index + 1}: the target needs a GitHub origin.`)
    }
    if (identity.toLowerCase() === 'github.com/omnirogue/omnirogue') {
      throw new Error(
        `Spec ${index + 1}: this repository requires a hold label and checked preview; batch publication is not enabled for it.`
      )
    }
    if (
      !implementationApprovalCoversTarget(
        status.artifact.review?.question,
        identity,
        target.baseRef
      )
    ) {
      throw new Error(
        `Spec ${index + 1}: approval must name implementation, a draft PR, ${identity}, and ${target.baseRef}.`
      )
    }
    await gitExecFileAsync(['check-ref-format', '--branch', target.baseRef], { cwd: repo.path })
    const heads = (
      await gitExecFileAsync(['ls-remote', '--heads', 'origin', target.baseRef], {
        cwd: repo.path
      })
    ).stdout.trim()
    const baseOid = heads.split(/\s+/)[0]
    if (!/^[a-f0-9]{40,64}$/.test(baseOid) || !heads.endsWith(`refs/heads/${target.baseRef}`)) {
      throw new Error(`Spec ${index + 1}: the base branch is not published on origin.`)
    }
    await gitExecFileAsync(['cat-file', '-e', `${baseOid}^{commit}`], { cwd: repo.path })
    const source = await runtime.readArtifactContextDocument(target.artifactSlug)
    if (source.status !== 'ok' || source.value.truncated || !source.value.content.trim()) {
      throw new Error(`Spec ${index + 1}: the full source is unavailable on this host.`)
    }
    assertPrincipal()
    slots.push({
      ...target,
      index,
      title: source.value.title,
      sourceSha256: specSourceDigest(source.value.content),
      snapshotPath: '',
      baseOid,
      repoPath: repo.path,
      repoRemote: identity,
      phase: 'reserved'
    })
  }
  for (const slot of slots) {
    slot.snapshotPath = join(scope.directory, id, `spec-${slot.index + 1}.json`)
    const source = await runtime.readArtifactContextDocument(slot.artifactSlug)
    if (
      source.status !== 'ok' ||
      source.value.truncated ||
      specSourceDigest(source.value.content) !== slot.sourceSha256
    ) {
      throw new Error(`Spec ${slot.index + 1}: the source changed before reservation.`)
    }
    writeDurableSecureJsonFile(slot.snapshotPath, { content: source.value.content })
  }
  assertPrincipal()
  return slots as SpecPrBatch['slots']
}
