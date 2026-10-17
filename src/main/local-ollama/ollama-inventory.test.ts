import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOllamaModels, pullOllamaModel, resolveOllamaBaseUrl } from './ollama-inventory'

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listOllamaModels', () => {
  it('reports the installed tags, namespaced ones included, sorted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          models: [
            {
              name: 'qwen3-coder:30b',
              size: 1,
              details: { family: 'qwen3', parameter_size: '30B' }
            },
            { name: 'hf.co/org/model:Q4_K_M', size: 2 },
            { name: 'not a tag', size: 3 }
          ]
        })
      )
    )
    const inventory = await listOllamaModels('http://127.0.0.1:11434/')
    expect(inventory).toMatchObject({ status: 'connected', baseUrl: 'http://127.0.0.1:11434' })
    if (inventory.status !== 'connected') {
      throw new Error('expected connected')
    }
    expect(inventory.models.map((model) => model.name)).toEqual([
      'hf.co/org/model:Q4_K_M',
      'qwen3-coder:30b'
    ])
    expect(inventory.models[1]).toMatchObject({ family: 'qwen3', parameterSize: '30B' })
  })

  it('reports loss of contact and malformed bodies as disconnected, never as no models', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    expect(await listOllamaModels()).toMatchObject({
      status: 'disconnected',
      message: 'ECONNREFUSED'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'busy' }))
    )
    expect(await listOllamaModels()).toMatchObject({ status: 'disconnected', message: 'busy' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ models: {} }))
    )
    expect(await listOllamaModels()).toMatchObject({ status: 'disconnected' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    )
    expect(await listOllamaModels()).toMatchObject({ status: 'disconnected', message: 'HTTP 500' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'boom' }, { status: 500 }))
    )
    expect(await listOllamaModels()).toMatchObject({
      status: 'disconnected',
      message: 'HTTP 500: boom'
    })
  })
})

describe('resolveOllamaBaseUrl', () => {
  it('honours OLLAMA_HOST forms the ollama CLI accepts', () => {
    const previous = process.env.OLLAMA_HOST
    try {
      process.env.OLLAMA_HOST = ':5000'
      expect(resolveOllamaBaseUrl()).toBe('http://127.0.0.1:5000')
      process.env.OLLAMA_HOST = '192.168.1.100:11434/'
      expect(resolveOllamaBaseUrl()).toBe('http://192.168.1.100:11434')
      expect(resolveOllamaBaseUrl('https://ollama.example')).toBe('https://ollama.example')
      process.env.OLLAMA_HOST = '0.0.0.0'
      expect(resolveOllamaBaseUrl()).toBe('http://0.0.0.0:11434')
      process.env.OLLAMA_HOST = 'proxy.local:80'
      expect(resolveOllamaBaseUrl()).toBe('http://proxy.local')
      expect(resolveOllamaBaseUrl('https://ollama.example:443')).toBe('https://ollama.example')
      expect(resolveOllamaBaseUrl('http://gpu-box:11434/v1')).toBe('http://gpu-box:11434')
      process.env.OLLAMA_HOST = '::1'
      expect(resolveOllamaBaseUrl()).toBe('http://[::1]:11434')
      process.env.OLLAMA_HOST = '[::1]:5000'
      expect(resolveOllamaBaseUrl()).toBe('http://[::1]:5000')
      expect(resolveOllamaBaseUrl('http://[fe80::1]:11434/')).toBe('http://[fe80::1]:11434')
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_HOST
      } else {
        process.env.OLLAMA_HOST = previous
      }
    }
  })
})

describe('pullOllamaModel', () => {
  it('parses NDJSON split across chunks, with CRLF, and resolves on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse([
          '{"status":"pulling manifest"}\r\n{"status":"downloading","comple',
          'ted":50,"total":100}\n',
          '{"status":"success"}\n'
        ])
      )
    )
    const seen: { status: string; completedBytes?: number }[] = []
    const result = await pullOllamaModel({
      model: 'gemma3:12b',
      onProgress: (progress) => seen.push(progress)
    })
    expect(result).toEqual({ ok: true })
    expect(seen.map((entry) => entry.status)).toEqual([
      'pulling manifest',
      'downloading',
      'success'
    ])
    expect(seen[1]!.completedBytes).toBe(50)
  })

  it('keeps a confirmed success when the stream errors or stalls afterwards', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"status":"success"}\n'))
                setTimeout(() => controller.error(new Error('socket closed after success')), 20)
              }
            }),
            { status: 200 }
          )
      )
    )
    expect(await pullOllamaModel({ model: 'gemma3:12b' })).toEqual({ ok: true })
  })

  it('surfaces an error event and refuses invalid tags before any request', async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        '{"status":"pulling"}\n',
        '{"error":"pull model manifest: file does not exist"}\n'
      ])
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await pullOllamaModel({ model: 'nope:1' })).toEqual({
      ok: false,
      message: 'pull model manifest: file does not exist'
    })
    expect(await pullOllamaModel({ model: 'not a tag' })).toMatchObject({ ok: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
