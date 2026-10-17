import { createServer, type RequestListener, type Server } from 'node:http'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeerInboxPendingClientError, readPeerInboxPending } from './peer-inbox-pending-client'

const TOKEN = 'fixture_peer-token.123'
const PENDING = {
  schema_version: 1,
  pending: 3,
  available: 1,
  leased: 1,
  blocked: 1,
  communication: { idle_wake: false }
}
let tokenFile: string
let directory: string
const servers: Server[] = []

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'peer-pending-client-'))
  tokenFile = join(directory, 'private.token')
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
})

afterEach(async () => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await rm(directory, { recursive: true, force: true })
})

describe('readPeerInboxPending', () => {
  it('posts only the fixed pending operation to the exact origin and leaves credentials unchanged', async () => {
    const requests: { url?: string; method?: string; authorization?: string; body: string }[] = []
    const apiOrigin = await listen(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
      }
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString()
      })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(PENDING))
    })
    const before = await stat(tokenFile)
    expect(await readPeerInboxPending({ apiOrigin, tokenFile })).toEqual(PENDING)
    expect(requests).toEqual([
      {
        url: '/api/session-peers/agent',
        method: 'POST',
        authorization: `Bearer ${TOKEN}`,
        body: JSON.stringify({ action: 'pending', parameters: {} })
      }
    ])
    expect(await readFile(tokenFile, 'utf8')).toBe(`${TOKEN}\n`)
    expect((await stat(tokenFile)).mode).toBe(before.mode)
  })

  it.each([
    'http://api.example.test',
    'http://192.168.1.10',
    'ftp://example.test',
    'https://user:password@example.test',
    'https://example.test/path',
    'https://example.test/',
    'https://example.test?token=secret',
    'https://example.test#secret',
    'https://example.test?',
    'not-an-origin'
  ])('refuses non-origin or nonsecure configuration %s before fetching', async (apiOrigin) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(readPeerInboxPending({ apiOrigin, tokenFile }, { fetch })).rejects.toThrow(
      'invalid_origin'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://api.example.test', 'http://localhost:1234', 'http://[::1]:1234'])(
    'allows the configured secure or loopback origin %s',
    async (apiOrigin) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'))
      await readPeerInboxPending({ apiOrigin, tokenFile }, { fetch })
      expect(fetch).toHaveBeenCalledWith(
        `${apiOrigin}/api/session-peers/agent`,
        expect.objectContaining({ redirect: 'error', credentials: 'omit' })
      )
    }
  )

  it('does not follow redirects or send the credential to the redirect target', async () => {
    let redirectedRequests = 0
    const destination = await listen((_request, response) => {
      redirectedRequests++
      response.end('{}')
    })
    let sourceRequests = 0
    const apiOrigin = await listen((_request, response) => {
      sourceRequests++
      response.writeHead(307, { location: `${destination}/different-operation` })
      response.end()
    })
    await expect(readPeerInboxPending({ apiOrigin, tokenFile })).rejects.toThrow('request_failed')
    expect(sourceRequests).toBe(1)
    expect(redirectedRequests).toBe(0)
  })

  it('sanitizes HTTP errors without reading their body or retrying', async () => {
    let requests = 0
    const apiOrigin = await listen((_request, response) => {
      requests++
      response.writeHead(401)
      response.end(`server secret ${TOKEN}`)
    })
    const error = await readPeerInboxPending({ apiOrigin, tokenFile }).catch(
      (error: unknown) => error
    )
    expect(error).toBeInstanceOf(PeerInboxPendingClientError)
    if (!(error instanceof PeerInboxPendingClientError)) {
      throw new Error('Expected PeerInboxPendingClientError')
    }
    expect(error.code).toBe('http_error')
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN)
    expect(String(error)).not.toContain('server secret')
    expect(requests).toBe(1)
  })

  it('sanitizes transport exceptions, including abort reasons', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(TOKEN))
    const error = await readPeerInboxPending(
      { apiOrigin: 'https://api.example.test', tokenFile },
      { fetch }
    ).catch((error: unknown) => error)
    if (!(error instanceof PeerInboxPendingClientError)) {
      throw new Error('Expected PeerInboxPendingClientError')
    }
    expect(error.code).toBe('request_failed')
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN)
    const controller = new AbortController()
    controller.abort(new Error(TOKEN))
    await expect(
      readPeerInboxPending(
        { apiOrigin: 'https://api.example.test', tokenFile: '/not/read' },
        { signal: controller.signal, fetch }
      )
    ).rejects.toThrow('request_aborted')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink credential', async () => {
    const link = join(directory, 'credential-link')
    await symlink(tokenFile, link)
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      readPeerInboxPending({ apiOrigin: 'https://api.example.test', tokenFile: link }, { fetch })
    ).rejects.toThrow('invalid_token_file')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses broad file permissions without changing them',
    async () => {
      await chmod(tokenFile, 0o640)
      const fetch = vi.fn<typeof globalThis.fetch>()
      await expect(
        readPeerInboxPending({ apiOrigin: 'https://api.example.test', tokenFile }, { fetch })
      ).rejects.toThrow('invalid_token_file')
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o640)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each(['', 'x'.repeat(4097), 'line\nbreak', ' token', 'a=b'])(
    'rejects malformed or oversized credential case %# without fetching',
    async (contents) => {
      await writeFile(tokenFile, contents)
      const fetch = vi.fn<typeof globalThis.fetch>()
      const error = await readPeerInboxPending(
        { apiOrigin: 'https://api.example.test', tokenFile },
        { fetch }
      ).catch((error: unknown) => error)
      if (!(error instanceof PeerInboxPendingClientError)) {
        throw new Error('Expected PeerInboxPendingClientError')
      }
      expect(error.code).toBe('invalid_token_file')
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('requires an absolute regular file and sanitizes missing-file errors', async () => {
    for (const path of ['relative.token', directory, join(directory, TOKEN)]) {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const error = await readPeerInboxPending(
        { apiOrigin: 'https://api.example.test', tokenFile: path },
        { fetch }
      ).catch((error: unknown) => error)
      if (!(error instanceof PeerInboxPendingClientError)) {
        throw new Error('Expected PeerInboxPendingClientError')
      }
      expect(error.code).toBe('invalid_token_file')
      expect(String(error)).not.toContain(TOKEN)
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])(
    'bounds streamed response bytes (declared length: %s)',
    async (declared) => {
      const apiOrigin = await listen((_request, response) => {
        if (declared) {
          response.setHeader('content-length', 65537)
        }
        response.end('x'.repeat(65537))
      })
      await expect(readPeerInboxPending({ apiOrigin, tokenFile })).rejects.toThrow(
        'response_too_large'
      )
    }
  )

  it('rejects invalid JSON without including the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(TOKEN))
    const error = await readPeerInboxPending(
      { apiOrigin: 'https://api.example.test', tokenFile },
      { fetch }
    ).catch((error: unknown) => error)
    if (!(error instanceof PeerInboxPendingClientError)) {
      throw new Error('Expected PeerInboxPendingClientError')
    }
    expect(error.code).toBe('invalid_response')
    expect(String(error) + JSON.stringify(error)).not.toContain(TOKEN)
  })

  it('aborts an in-flight response body', async () => {
    let received: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      received = resolve
    })
    const apiOrigin = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
      received()
    })
    const controller = new AbortController()
    const result = readPeerInboxPending({ apiOrigin, tokenFile }, { signal: controller.signal })
    const rejected = expect(result).rejects.toThrow('request_aborted')
    await started
    controller.abort()
    await rejected
  })

  it('enforces a five-second timeout even if a transport ignores cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started: () => void = () => {}
    const fetched = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      started()
      return await new Promise<Response>(() => {})
    })
    const result = readPeerInboxPending(
      { apiOrigin: 'https://api.example.test', tokenFile },
      { fetch }
    )
    const rejected = expect(result).rejects.toThrow('request_timeout')
    await fetched
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
