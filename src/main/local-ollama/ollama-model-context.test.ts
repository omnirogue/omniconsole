import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'
import { readOllamaModelContext } from './ollama-model-context'

afterEach(() => vi.unstubAllGlobals())

function metadata(running: unknown, details: unknown) {
  const fetchMock = vi.fn(async (url: string) =>
    Response.json(url.endsWith('/api/ps') ? running : details)
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('readOllamaModelContext', () => {
  it('reads the selected loaded model on the configured server, not another model', async () => {
    const fetchMock = metadata(
      {
        models: [
          { name: 'other:latest', context_length: 262_144 },
          { model: 'gemma4:e2b-mlx', context_length: 131_072 }
        ]
      },
      { model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 131_072 } }
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx', 'http://gpu-box:11434/v1')).toBe(131_072)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://gpu-box:11434/api/ps',
      'http://gpu-box:11434/api/show'
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gpu-box:11434/api/show',
      expect.objectContaining({ method: 'POST', body: '{"model":"gemma4:e2b-mlx"}' })
    )
  })

  it('prefers a smaller actual runner window over the model default or native capacity', async () => {
    metadata(
      { models: [{ name: 'gemma4:e2b-mlx', context_length: 4096 }] },
      { parameters: 'num_ctx 131072', model_info: { 'gemma4.context_length': 131_072 } }
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBe(4096)
  })

  it('uses an unloaded model explicit num_ctx bounded by its native capacity', async () => {
    metadata(
      { models: [] },
      {
        parameters: 'temperature 0.7\nnum_ctx                          262144\n',
        model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 131_072 }
      }
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBe(131_072)
  })

  it('accepts an explicit window without native metadata and matches the implicit latest tag', async () => {
    metadata({ models: [{ name: 'qwen3:latest', context_length: 32_768 }] }, {})
    expect(await readOllamaModelContext('qwen3')).toBe(32_768)
    metadata({ models: [] }, { parameters: 'num_ctx 65536' })
    expect(await readOllamaModelContext('qwen3')).toBe(65_536)
  })

  it('does not guess the runner window from native capacity or unrelated loaded models', async () => {
    metadata(
      { models: [{ name: 'gemma4:e4b-mlx', context_length: 131_072 }] },
      { model_info: { 'gemma4.context_length': 131_072 } }
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBeUndefined()
  })

  it.each([0, -1, '131072', 4096.5, null])('ignores malformed context %s', async (value) => {
    metadata(
      { models: [{ name: 'gemma4:e2b-mlx', context_length: value }] },
      { parameters: 'num_ctx invalid', model_info: { 'gemma4.context_length': 131_072 } }
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBeUndefined()
  })

  it('keeps an actual loaded window when optional model details cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/show')) {
          throw new Error('ECONNRESET')
        }
        return Response.json({ models: [{ name: 'gemma4:e2b-mlx', context_length: 131_072 }] })
      })
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBe(131_072)
  })

  it('returns unknown on contact loss, HTTP errors and malformed response bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBeUndefined()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 }))
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBeUndefined()
    metadata({ models: [null, 'junk'] }, { model_info: null })
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBeUndefined()
  })

  it('cancels both unread HTTP error bodies before returning unknown', async () => {
    const cancelled = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => cancelTrackingResponse(503, cancelled))
    )
    expect(await readOllamaModelContext('gemma4:e2b-mlx')).toBeUndefined()
    expect(cancelled).toHaveBeenCalledTimes(2)
  })

  it('refuses malformed model tags without contacting a server', async () => {
    const fetchMock = metadata({}, {})
    expect(await readOllamaModelContext('not a model')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
