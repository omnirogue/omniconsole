import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})
it('caches public metadata, selects structured models, and records tool capability', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      data: [
        {
          id: 'deepseek/chat',
          name: 'DeepSeek',
          context_length: 128000,
          pricing: { prompt: '0.0000001', completion: '0.0000002' },
          supported_parameters: ['tools', 'structured_outputs']
        },
        {
          id: 'qwen/plain',
          name: 'Plain',
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: []
        },
        {
          id: 'qwen/schema',
          name: 'Schema',
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['structured_outputs']
        }
      ]
    })
  )
  vi.stubGlobal('fetch', fetcher)
  const { workflowOpenRouterModels, workflowOpenRouterCatalog } =
    await import('./workflow-openrouter-catalog')
  const [first, second] = await Promise.all([
    workflowOpenRouterModels(),
    workflowOpenRouterModels()
  ])
  expect(first).toEqual(second)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]).toHaveLength(2)
  const catalog = await workflowOpenRouterCatalog()
  expect(catalog.map((model) => model.catalog.id)).toEqual(['deepseek/chat', 'qwen/schema'])
  expect(catalog[0]).toMatchObject({
    lineage: 'deepseek',
    supportsTools: true,
    catalog: { isDefault: false }
  })
  expect(catalog[1].supportsTools).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
