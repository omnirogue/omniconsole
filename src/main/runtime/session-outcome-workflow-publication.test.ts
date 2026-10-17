import type * as ReviewReadback from '../console-workflows/console-github-review-readback'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { closedSessionOutcomeStages } from './session-outcome-workflow-projection'
import { publishSessionOutcomeMerge } from './session-outcome-workflow-publication'
import { resumeSessionOutcomeWork } from './session-outcome-resume'
import {
  verifyGitHubReviewAdmission,
  readMergedGitHubReview,
  GitHubReviewReadbackError
} from '../console-workflows/console-github-review-readback'

vi.mock('./session-outcome-handoff', () => ({
  readSessionOutcomePrincipal: vi.fn(async () => 'person')
}))
vi.mock('../console-workflows/console-github-review-readback', async (importOriginal) => {
  const original = await importOriginal<typeof ReviewReadback>()
  return { ...original, verifyGitHubReviewAdmission: vi.fn(), readMergedGitHubReview: vi.fn() }
})
beforeEach(() => vi.clearAllMocks())
function fixture() {
  const { workflow, jobs, candidate } = workflowProofFixture()
  workflow.closedStages = closedSessionOutcomeStages(workflow, jobs).map((stage) => ({
    key: stage.key,
    round: stage.round,
    reviewJobIds: stage.reviews.map((review) => review.jobId),
    producerJobId: stage.producer?.jobId,
    verificationReportId: stage.verificationReportId,
    evidenceId: stage.evidenceId
  }))
  let chain = {
    id: 'publication',
    workspacePath: '/workspace',
    worktreeId: 'wt_fixture',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'source',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      workflow,
      completedSteps: [],
      attempts: [],
      removals: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        state: 'owned',
        principal: 'person',
        taskId: 'btk_root',
        sourceReady: true
      },
      outcomes: [
        {
          id: 'build',
          title: 'Build and review',
          finish: 'pr',
          revision: 1,
          status: 'satisfied',
          evidence: [],
          dependsOn: [],
          conditions: [],
          actions: []
        },
        {
          id: 'merge',
          title: 'Merge exact review',
          finish: 'merge',
          revision: 1,
          status: 'pending',
          evidence: [],
          dependsOn: ['build'],
          conditions: [
            {
              id: 'merge',
              kind: 'merge',
              target: 'Reviewed PR',
              targetBranch: 'main',
              repository: 'repo_fixture'
            }
          ],
          actions: []
        }
      ]
    }
  } as SessionChain
  const writes: SessionChain[] = []
  const merge = vi.fn(async () => ({ ok: true }))
  const service = {
    runtime: {
      showManagedTerminalWorkspace: vi.fn(async () => ({ repoId: 'repo_fixture' })),
      showRepo: vi.fn(async () => ({ id: 'repo_fixture', connectionId: null })),
      getStatus: vi.fn(() => ({ capabilities: ['github.mergePR.expected-head.v1'] })),
      mergeRepoPR: merge
    },
    save: vi.fn((next: SessionChain) => {
      chain = structuredClone(next)
      writes.push(chain)
      return chain
    })
  } as unknown as SessionOutcomeService
  vi.mocked(verifyGitHubReviewAdmission).mockImplementation(async (input) => ({
    provider: 'github',
    producerGitSha: input.producerGitSha,
    acceptedReviews: input.acceptedReviews,
    review: {
      repo: input.repo,
      prNumber: input.prNumber,
      url: 'https://github.com/omnirogue/fixture/pull/123',
      state: 'open',
      headRef: input.headRef,
      baseRef: input.expectedBaseRef,
      headSha: input.producerGitSha,
      mergeCommitSha: null
    }
  }))
  const notMerged = () =>
    Promise.reject(new GitHubReviewReadbackError('not-merged', 'The PR is still open.'))
  vi.mocked(readMergedGitHubReview).mockImplementation(notMerged)
  const merged = () =>
    vi.mocked(readMergedGitHubReview).mockImplementation(async (admission) => ({
      ...admission,
      review: { ...admission.review, state: 'merged', mergeCommitSha: 'd'.repeat(40) }
    }))
  return { get: () => chain, service, merge, writes, candidate, merged }
}
it('persists exact review/head/base intent before merge and waits for independent merged readback', async () => {
  const f = fixture()
  f.merge.mockImplementation(async () => {
    expect(f.get().outcomeSet!.publications![0]!.state).toBe('requested')
    return { ok: true }
  })
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  expect(f.merge).toHaveBeenCalledWith(
    'repo_fixture',
    123,
    undefined,
    { owner: 'omnirogue', repo: 'fixture' },
    f.candidate
  )
  expect(verifyGitHubReviewAdmission).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedBaseRef: 'main',
      expectedReviewerIds: [
        'wf_frozenproof:build__loop_r1_p1:codex/gpt-6-astra',
        'wf_frozenproof:build__loop_r1_p2:codex/gpt-5.6-sol'
      ],
      acceptedReviews: [
        expect.objectContaining({ artifactId: 'job_proof1:runner_result_receipt:2' }),
        expect.objectContaining({ artifactId: 'job_proof2:runner_result_receipt:3' })
      ]
    })
  )
  expect(f.get().outcomeSet!.publications![0]!.state).toBe('requested')
  expect(f.get().outcomeSet!.outcomes[1]!.evidence).toEqual([])
  f.merged()
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  expect(f.merge).toHaveBeenCalledOnce()
  expect(f.get().outcomeSet!.publications![0]).toMatchObject({
    state: 'merged',
    mergeCommitSha: 'd'.repeat(40)
  })
})
it('recovers an uncertain response by reading the provider without repeating merge', async () => {
  const f = fixture()
  f.merge.mockRejectedValueOnce(new Error('Connection lost after merge request'))
  await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow(
    'Connection lost'
  )
  const restored = structuredClone(f.get())
  f.merged()
  await publishSessionOutcomeMerge(f.service, restored, 'merge')
  expect(f.merge).toHaveBeenCalledOnce()
  expect(f.get().outcomeSet!.publications![0]!.state).toBe('merged')
})
it('retries a lost merge response only after provider readback proves the same PR is still open', async () => {
  const f = fixture()
  f.merge.mockRejectedValueOnce(new Error('Connection lost before response'))
  await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow(
    'Connection lost'
  )
  expect(f.get().outcomeSet!.publications![0]!.state).toBe('requested')
  await resumeSessionOutcomeWork(f.service, f.get())
  expect(f.get().outcomeSet!.publications![0]!.state).toBe('prepared')
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  expect(f.merge).toHaveBeenCalledTimes(2)
})

it('records a known returned refusal as blocked without an indefinite requested state', async () => {
  const f = fixture()
  f.merge.mockResolvedValueOnce({ ok: false, error: 'Required check is failing' } as never)
  await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow(
    'Required check'
  )
  expect(f.get().outcomeSet!.publications![0]).toMatchObject({
    state: 'blocked',
    error: 'Required check is failing'
  })
  await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow(
    'Required check'
  )
  expect(f.merge).toHaveBeenCalledOnce()
})
it('does not issue merge when durable intent persistence fails', async () => {
  const f = fixture()
  vi.mocked(f.service.save).mockImplementation(() => {
    throw new Error('Disk full')
  })
  await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow('Disk full')
  expect(f.merge).not.toHaveBeenCalled()
})
it.each(['repository', 'base', 'reviewer', 'blocker'] as const)(
  'refuses changed %s authority before publication',
  async (kind) => {
    const f = fixture(),
      workflow = f.get().outcomeSet!.workflow!
    if (kind === 'repository') {
      workflow.preview.graph.nodes[1]!.repo = 'https://github.com/other/project.git'
    }
    if (kind === 'base') {
      workflow.preview.graph.nodes[1]!.base_branch = 'release'
    }
    if (kind === 'reviewer') {
      workflow.receipts![1]!.verdict!.verdict = 'disagree'
    }
    if (kind === 'blocker') {
      workflow.receipts![1]!.verdict!.blockers = ['Unresolved']
    }
    await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow()
    expect(f.merge).not.toHaveBeenCalled()
  }
)

it('binds retained publication to the current exact review receipt versions before reuse', async () => {
  const f = fixture()
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  f.get().outcomeSet!.workflow!.receipts![1]!.fingerprint = '9'.repeat(64)
  await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow(
    'previous merge request'
  )
  expect(f.merge).toHaveBeenCalledOnce()
})
it('uses existing provider merged state for a newly reviewed packet without repeating publication', async () => {
  const f = fixture()
  vi.mocked(verifyGitHubReviewAdmission).mockImplementation(async (input) => ({
    provider: 'github',
    producerGitSha: input.producerGitSha,
    acceptedReviews: input.acceptedReviews,
    review: {
      repo: input.repo,
      prNumber: input.prNumber,
      url: 'https://github.com/omnirogue/fixture/pull/123',
      state: 'merged',
      headRef: input.headRef,
      baseRef: input.expectedBaseRef,
      headSha: input.producerGitSha,
      mergeCommitSha: 'd'.repeat(40)
    }
  }))
  f.merged()
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  expect(f.merge).not.toHaveBeenCalled()
  expect(f.get().outcomeSet!.publications![0]!.state).toBe('merged')
})
it.each(['missing-capability', 'remote-owner'])(
  'refuses %s before issuing a guarded merge',
  async (kind) => {
    const f = fixture()
    if (kind === 'missing-capability') {
      vi.mocked(f.service.runtime.getStatus).mockReturnValue({ capabilities: [] } as never)
    } else {
      vi.mocked(f.service.runtime.showRepo).mockResolvedValue({
        id: 'repo_fixture',
        connectionId: 'remote'
      } as never)
    }
    await expect(publishSessionOutcomeMerge(f.service, f.get(), 'merge')).rejects.toThrow()
    expect(f.merge).not.toHaveBeenCalled()
    expect(f.get().outcomeSet!.publications![0]!.state).toBe('prepared')
  }
)

it('reconciles a previously uncertain merge before binding an amended review packet', async () => {
  const f = fixture()
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  f.get().outcomeSet!.workflow!.receipts![1]!.fingerprint = '9'.repeat(64)
  f.merged()
  vi.mocked(verifyGitHubReviewAdmission).mockImplementation(async (input) => ({
    provider: 'github',
    producerGitSha: input.producerGitSha,
    acceptedReviews: input.acceptedReviews,
    review: {
      repo: input.repo,
      prNumber: input.prNumber,
      url: 'https://github.com/omnirogue/fixture/pull/123',
      state: 'merged',
      headRef: input.headRef,
      baseRef: input.expectedBaseRef,
      headSha: input.producerGitSha,
      mergeCommitSha: 'd'.repeat(40)
    }
  }))
  await publishSessionOutcomeMerge(f.service, f.get(), 'merge')
  expect(f.merge).toHaveBeenCalledOnce()
  expect(f.get().outcomeSet!.publications).toHaveLength(2)
  expect(f.get().outcomeSet!.publications!.every((entry) => entry.state === 'merged')).toBe(true)
  expect(
    f.get().outcomeSet!.publications![0]!.admission.acceptedReviews[0]!.artifactVersion
  ).not.toBe(f.get().outcomeSet!.publications![1]!.admission.acceptedReviews[0]!.artifactVersion)
})
