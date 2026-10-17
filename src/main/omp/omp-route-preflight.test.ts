import { expect, it, vi } from 'vitest'
import { assertLocalOmpRoute } from './omp-route-preflight'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
it('requires auth discovery on the execution host and tools on every candidate', async () => {
  const route = {
    model: 'openrouter/x-ai/grok-exact',
    openrouterCandidates: ['x-ai/grok-exact', 'google/gemini-exact']
  }
  const discover = vi.fn().mockResolvedValue({
    success: true,
    catalogOrigin: 'probe',
    models: route.openrouterCandidates.map((id) => ({
      id: `openrouter/${id}`,
      openrouterRouting: 'omp-openrouter-routing-v1'
    }))
  })
  const runtime = { discoverRuntimeCommitMessageModels: discover } as unknown as Pick<
    OrcaRuntimeService,
    'discoverRuntimeCommitMessageModels'
  >
  await expect(assertLocalOmpRoute(runtime, 'id:folder', route)).resolves.toBeUndefined()
  expect(discover).toHaveBeenCalledWith('id:folder', 'omp')
  discover.mockResolvedValue({
    success: true,
    catalogOrigin: 'probe',
    models: route.openrouterCandidates.map((id) => ({ id: `openrouter/${id}` }))
  })
  await expect(assertLocalOmpRoute(runtime, 'id:folder', route)).rejects.toThrow('execution host')
  discover.mockResolvedValue({ success: true, catalogOrigin: 'cache', models: [] })
  await expect(assertLocalOmpRoute(runtime, 'id:folder', route)).rejects.toThrow('execution host')
})
