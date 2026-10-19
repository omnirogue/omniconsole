import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { implementationApprovalCoversTarget } from '../../shared/spec-pr-batch'
import { prepareSpecPrBatchSlots } from './spec-pr-batch-preflight'

describe('spec PR batch admission', () => {
  it('requires the implementation action and exact repository/base in the approved question', () => {
    expect(
      implementationApprovalCoversTarget(
        'Implement this revision in omnirogue/omni-ide against main-next and open a draft PR.',
        'github.com/omnirogue/omni-ide',
        'main-next'
      )
    ).toBe(true)
    expect(
      implementationApprovalCoversTarget(
        'Approve this spec for publication.',
        'github.com/omnirogue/omni-ide',
        'main-next'
      )
    ).toBe(false)
    expect(
      implementationApprovalCoversTarget(
        'Implement this revision in omnirogue/other against main-next and open a draft PR.',
        'github.com/omnirogue/omni-ide',
        'main-next'
      )
    ).toBe(false)
  })

  it('rejects a changed approval before inspecting a repository or launching work', async () => {
    const showRepo = vi.fn()
    const runtime = {
      getArtifactReviewStatus: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          status: 'approved',
          latest: { id: 'older-decision', decision: 'approved', revision: 1 },
          artifact: { revision: 2, sourceContentType: 'text/markdown' }
        }
      }),
      showRepo
    } as unknown as OrcaRuntimeService
    const targets = Array.from({ length: 5 }, (_, index) => ({
      artifactSlug: `spec_${index}`,
      revision: 2,
      decisionId: 'current-decision',
      repoId: 'repo-1',
      baseRef: 'main-next'
    })) as Parameters<typeof prepareSpecPrBatchSlots>[1]['targets']
    await expect(
      prepareSpecPrBatchSlots(
        runtime,
        { mutationId: crypto.randomUUID(), agent: 'codex', targets },
        { principal: 'person', directory: '/unused' },
        'spb_test',
        () => undefined
      )
    ).rejects.toThrow('exact current review')
    expect(showRepo).not.toHaveBeenCalled()
  })
})
