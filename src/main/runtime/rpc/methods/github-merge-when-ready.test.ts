import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { GITHUB_METHODS } from './github'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('github.project.mergeWhenReadyFactsBySlug', () => {
  it('reads merge when ready facts by slug and rejects oversized batches', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getGitHubMergeWhenReadyFactsBySlug: vi
        .fn()
        .mockResolvedValue({ ok: true, pullRequests: [], missing: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('github.project.mergeWhenReadyFactsBySlug', {
        owner: 'acme',
        repo: 'omni',
        numbers: [9, 10]
      })
    )
    const oversized = await dispatcher.dispatch(
      makeRequest('github.project.mergeWhenReadyFactsBySlug', {
        owner: 'acme',
        repo: 'omni',
        numbers: Array.from({ length: 51 }, (_, i) => i + 1)
      })
    )

    expect(runtime.getGitHubMergeWhenReadyFactsBySlug).toHaveBeenCalledTimes(1)
    expect(runtime.getGitHubMergeWhenReadyFactsBySlug).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'omni',
      numbers: [9, 10]
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true, pullRequests: [] } })
    expect(oversized).toMatchObject({ ok: false })
  })
})
