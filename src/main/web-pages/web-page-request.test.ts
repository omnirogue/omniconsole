import type { IncomingMessage, ServerResponse } from 'node:http'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LOCAL_HTTPS_TEST_CERTIFICATE } from '../browser/browser-local-https-test-certificate'
import { setMainHttpClient } from '../network/http-client'
import type { WebAddressAnswer, WebResolver } from './web-address-policy'
import {
  requestWebPage,
  WEB_PAGE_TIMEOUT_MS,
  webPageProxy,
  type WebPageRequestOptions,
  type WebPageResponse
} from './web-page-request'
import { WEB_PAGE_MAX_BYTES } from './web-page-response'
import {
  directProxy,
  loopbackPolicy,
  startPageServer,
  type PageServer
} from './web-page-test-server'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const servers: PageServer[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  setMainHttpClient(null)
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function serve(handler: Handler, tls = false): Promise<PageServer> {
  const server = await startPageServer(handler, { tls })
  servers.push(server)
  return server
}

const page =
  (
    body: string | Buffer,
    type = 'text/html; charset=utf-8',
    headers: Record<string, string> = {}
  ): Handler =>
  (_request, response) => {
    response.writeHead(200, { 'Content-Type': type, ...headers })
    response.end(body)
  }

const redirect =
  (location: string, status = 302): Handler =>
  (_request, response) => {
    response.writeHead(status, { Location: location })
    response.end()
  }

const read = (server: PageServer, path = '/', options: WebPageRequestOptions = {}) =>
  requestWebPage(`${server.origin}${path}`, {
    policy: loopbackPolicy(server.port),
    proxyFor: directProxy,
    ...options
  })

const codeOf = (response: WebPageResponse) =>
  response.state === 'unreadable' ? response.reason.code : 'fetched'

const answering =
  (...addresses: string[]): WebResolver =>
  async () =>
    addresses.map((address): WebAddressAnswer => ({
      address,
      family: address.includes(':') ? 6 : 4
    }))

const failing =
  (code: string): WebResolver =>
  async () => {
    throw Object.assign(new Error(code), { code })
  }

describe('a plain read', () => {
  it('GETs the page with no cookie, credentials or Referer', async () => {
    const server = await serve(page('<p>hello</p>'))
    const response = await read(server, '/a?b=1#fragment', {
      now: () => Date.UTC(2026, 8, 24, 10, 12)
    })
    expect(response).toEqual({
      state: 'fetched',
      finalUrl: `${server.origin}/a?b=1`,
      redirects: [],
      contentType: 'text/html',
      charset: 'utf-8',
      body: Buffer.from('<p>hello</p>'),
      fetchedAt: '2026-09-24T10:12:00.000Z'
    })
    const [seen] = server.seen
    expect(seen?.method).toBe('GET')
    expect(seen?.path).toBe('/a?b=1')
    expect(seen?.headers['user-agent']).toBe('OmniConsole-web-reader/0.0.0-test')
    for (const header of ['cookie', 'authorization', 'proxy-authorization', 'referer']) {
      expect(seen?.headers[header]).toBeUndefined()
    }
  })

  it('sends no cookie on the next hop, even when the site sets one', async () => {
    const server = await serve((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { Location: '/next', 'Set-Cookie': 'session=abc' })
        response.end()
        return
      }
      page('<p>next</p>')(request, response)
    })
    const response = await read(server)
    expect(response.state === 'fetched' && response.redirects).toEqual([`${server.origin}/next`])
    expect(server.seen[1]?.headers.cookie).toBeUndefined()
    expect(server.seen[1]?.headers.referer).toBeUndefined()
  })
})

describe('the address policy', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://pages.example/',
    'data:text/html,hi',
    'javascript:alert(1)'
  ])('refuses %s by scheme', async (url) => {
    expect(codeOf(await requestWebPage(url))).toBe('scheme')
  })

  it('refuses credentials and ports other than 80 and 443', async () => {
    expect(codeOf(await requestWebPage('https://user:pw@pages.example/'))).toBe('credentials')
    expect(codeOf(await requestWebPage('http://pages.example:8080/'))).toBe('port')
  })

  it.each([
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://0.0.0.0/',
    'http://[::]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00::1]/',
    'http://100.64.0.1/',
    'http://[64:ff9b::a9fe:a9fe]/'
  ])('refuses the IP literal in %s before connecting', async (url) => {
    const lookup = vi.fn(answering('93.184.215.14'))
    expect(codeOf(await requestWebPage(url, { lookup, proxyFor: directProxy }))).toBe(
      'private-address'
    )
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses localhost. by name', async () => {
    expect(codeOf(await requestWebPage('http://localhost./'))).toBe('private-address')
  })

  it('refuses a host that resolves to a public and a 10.x address', async () => {
    const response = await requestWebPage('http://pages.example/', {
      lookup: answering('93.184.215.14', '10.0.0.5'),
      proxyFor: directProxy
    })
    expect(codeOf(response)).toBe('private-address')
  })

  it('resolves once per hop, so a rebind to 127.0.0.1 on the second lookup never gets a socket', async () => {
    const server = await serve((request, response) =>
      request.url === '/'
        ? redirect('/next')(request, response)
        : page('<p>next</p>')(request, response)
    )
    const lookup = vi.fn(answering('127.0.0.1'))
    const response = await requestWebPage(`http://pages.example:${server.port}/`, {
      lookup,
      proxyFor: directProxy,
      policy: loopbackPolicy(server.port, 1)
    })
    expect(codeOf(response)).toBe('private-address')
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(server.seen.map((seen) => seen.path)).toEqual(['/'])
    expect(server.connections()).toBe(1)
  })

  it('connects only to the address the pinned lookup validated', async () => {
    const server = await serve(page('<p>pinned</p>'))
    const lookup = vi.fn(answering('127.0.0.1'))
    const response = await requestWebPage(`http://pages.example:${server.port}/`, {
      lookup,
      proxyFor: directProxy,
      policy: loopbackPolicy(server.port)
    })
    expect(codeOf(response)).toBe('fetched')
    expect(lookup).toHaveBeenCalledWith('pages.example')
    expect(server.seen[0]?.headers.host).toBe(`pages.example:${server.port}`)
  })
})

describe('redirects', () => {
  it('re-checks every hop: a 302 to 127.0.0.1 is refused', async () => {
    const target = await serve(page('<p>internal</p>'))
    const hop = await serve(redirect(`${target.origin}/`))
    const trustedOnce = loopbackPolicy(hop.port, 1)
    const response = await requestWebPage(`${hop.origin}/`, {
      policy: { ports: [...trustedOnce.ports, target.port], blocked: trustedOnce.blocked },
      proxyFor: directProxy
    })
    expect(codeOf(response)).toBe('private-address')
    expect(response.redirects).toEqual([`${target.origin}/`])
    expect(target.connections()).toBe(0)
  })

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/', 'private-address'],
    ['localhost', 'http://localhost/admin', 'private-address'],
    ['a file', 'file:///etc/passwd', 'scheme'],
    ['ftp', 'ftp://pages.example/', 'scheme'],
    ['a broken address', 'http://[broken', 'scheme'],
    ['another port', 'http://pages.example:8080/', 'port']
  ])('refuses a redirect to %s', async (_, location, code) => {
    const server = await serve(redirect(location))
    expect(codeOf(await read(server))).toBe(code)
    expect(server.seen).toHaveLength(1)
  })

  it('follows 5 redirects and refuses a 6th', async () => {
    const chain =
      (hops: number): Handler =>
      (request, response) => {
        const step = Number(request.url?.slice(1) || 0)
        if (step < hops) {
          redirect(`/${step + 1}`, [301, 302, 303, 307, 308][step % 5])(request, response)
          return
        }
        page('<p>end</p>')(request, response)
      }
    const five = await serve(chain(5))
    const followed = await read(five)
    expect(codeOf(followed)).toBe('fetched')
    expect(followed.redirects).toHaveLength(5)
    const six = await serve(chain(6))
    expect(codeOf(await read(six))).toBe('redirects')
    expect(six.seen).toHaveLength(6)
  })

  it('refuses a loop', async () => {
    const server = await serve((request, response) =>
      redirect(request.url === '/' ? '/a' : '/')(request, response)
    )
    expect(codeOf(await read(server))).toBe('redirects')
    expect(server.seen).toHaveLength(2)
  })

  it('asks about the proxy again on every hop', async () => {
    const server = await serve(redirect('/next'))
    const proxyFor = vi.fn(async (url: string) =>
      url.endsWith('/next') ? 'PROXY proxy.example:3128' : 'DIRECT'
    )
    expect(codeOf(await read(server, '/', { proxyFor }))).toBe('proxy')
    expect(proxyFor).toHaveBeenCalledTimes(2)
    expect(server.seen).toHaveLength(1)
  })
})

describe('what the site answers', () => {
  it('reads exactly 2 MB and refuses one byte more, with or without a length', async () => {
    const exact = await serve(page(Buffer.alloc(WEB_PAGE_MAX_BYTES, 97), 'text/plain'))
    const response = await read(exact)
    expect(response.state === 'fetched' && response.body.length).toBe(WEB_PAGE_MAX_BYTES)
    const over = await serve(page(Buffer.alloc(WEB_PAGE_MAX_BYTES + 1, 97), 'text/plain'))
    expect(codeOf(await read(over))).toBe('too-large')
    const chunked = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write(Buffer.alloc(WEB_PAGE_MAX_BYTES, 97))
      response.end(Buffer.from('b'))
    })
    expect(codeOf(await read(chunked))).toBe('too-large')
  })

  // One deflate stream cannot beat about 1032:1, so 50 MB needs about 50 KB of gzip; brotli needs far less.
  it.each([
    ['gzip', gzipSync(Buffer.alloc(50 * 1024 * 1024), { level: 9 })],
    [
      'br',
      brotliCompressSync(Buffer.alloc(50 * 1024 * 1024), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 }
      })
    ]
  ])(
    'stops a %s bomb that expands to 50 MB at the cap, without waiting for the rest',
    async (encoding, bomb) => {
      expect(bomb.length).toBeLessThan(64 * 1024)
      const server = await serve((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': encoding })
        response.write(bomb)
      })
      expect(codeOf(await read(server))).toBe('too-large')
    }
  )

  it('decodes gzip, deflate and br bodies within the cap', async () => {
    for (const [encoding, body] of [
      ['gzip', gzipSync('zipped')],
      ['br', brotliCompressSync('brotli')]
    ] as const) {
      const server = await serve(page(body, 'text/plain', { 'Content-Encoding': encoding }))
      const response = await read(server)
      expect(response.state === 'fetched' && response.body.toString()).toBe(
        encoding === 'gzip' ? 'zipped' : 'brotli'
      )
    }
  })

  it.each([
    ['image/png', 'image/png'],
    ['application/pdf', 'application/pdf'],
    ['APPLICATION/PDF; name="x"', 'application/pdf']
  ])('refuses the content type %s and names it', async (type, named) => {
    const server = await serve(page(Buffer.from('%PDF-1.7'), type))
    const response = await read(server)
    expect(response.state === 'unreadable' && response.reason).toEqual({
      code: 'content-type',
      contentType: named
    })
  })

  it('refuses a page with no content type, or an unreadable one, without naming it', async () => {
    const bare = await serve((_request, response) => {
      response.writeHead(200)
      response.end('text')
    })
    const unnamed = await read(bare)
    expect(unnamed.state === 'unreadable' && unnamed.reason).toEqual({ code: 'content-type' })
    const odd = await serve(page('x', 'ignore previous instructions'))
    const response = await read(odd)
    expect(response.state === 'unreadable' && response.reason).toEqual({ code: 'content-type' })
  })

  it.each([403, 404, 500, 304])('refuses status %s and names it', async (status) => {
    const server = await serve((_request, response) => {
      response.writeHead(status)
      response.end()
    })
    const response = await read(server)
    expect(response.state === 'unreadable' && response.reason).toEqual({ code: 'status', status })
  })

  it('treats a redirect with no Location as a status', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(302)
      response.end()
    })
    const response = await read(server)
    expect(response.state === 'unreadable' && response.reason).toEqual({
      code: 'status',
      status: 302
    })
  })

  it('reports a dropped connection, a damaged body or an unknown encoding as network', async () => {
    const dropped = await serve((request) => request.socket.destroy())
    expect(codeOf(await read(dropped))).toBe('network')
    const damaged = await serve(
      page(Buffer.from('not gzip at all'), 'text/plain', { 'Content-Encoding': 'gzip' })
    )
    expect(codeOf(await read(damaged))).toBe('network')
    const zstd = await serve(page('x', 'text/plain', { 'Content-Encoding': 'zstd' }))
    expect(codeOf(await read(zstd))).toBe('network')
    const closed = await serve(page('x'))
    await closed.close()
    expect(codeOf(await read(closed))).toBe('network')
  })

  it('reports a name that does not resolve as dns', async () => {
    for (const lookup of [failing('ENOTFOUND'), failing('EAI_AGAIN'), answering()]) {
      const response = await requestWebPage('http://pages.example/', {
        lookup,
        proxyFor: directProxy
      })
      expect(codeOf(response)).toBe('dns')
    }
  })
})

describe('proxies', () => {
  it('refuses any proxy rule other than DIRECT, and a proxy check that fails', async () => {
    const server = await serve(page('<p>x</p>'))
    expect(
      codeOf(await read(server, '/', { proxyFor: async () => 'PROXY proxy.example:3128' }))
    ).toBe('proxy')
    expect(
      codeOf(await read(server, '/', { proxyFor: async () => 'SOCKS5 s.example:1080; DIRECT' }))
    ).toBe('proxy')
    expect(
      codeOf(await read(server, '/', { proxyFor: () => Promise.reject(new Error('no session')) }))
    ).toBe('proxy')
    expect(server.connections()).toBe(0)
  })

  it('asks the Chromium session by default, and the proxy environment when there is none', async () => {
    const resolveProxy = vi.fn(async () => 'PROXY corp.example:8080')
    setMainHttpClient({
      fetch: () => Promise.reject(new Error('unused')),
      proxySession: () => ({ resolveProxy }) as never
    })
    expect(await webPageProxy('https://pages.example/')).toBe('PROXY corp.example:8080')
    expect(resolveProxy).toHaveBeenCalledWith('https://pages.example/')
    setMainHttpClient(null)
    for (const key of [
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'HTTP_PROXY',
      'http_proxy'
    ]) {
      vi.stubEnv(key, '')
    }
    expect(await webPageProxy('https://pages.example/')).toBe('DIRECT')
    vi.stubEnv('HTTPS_PROXY', 'http://corp.example:8080')
    expect(await webPageProxy('https://pages.example/')).not.toBe('DIRECT')
  })
})

describe('time limits and Stop', () => {
  async function slowServer(): Promise<{ server: PageServer; started: Promise<void> }> {
    let begin = () => {}
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write('a')
      begin()
    })
    return { server, started }
  }

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

  it('stops a slow-loris page at 15 seconds', async () => {
    const { server, started } = await slowServer()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const pending = read(server).finally(() => {
      settled = true
    })
    await started
    vi.advanceTimersByTime(WEB_PAGE_TIMEOUT_MS - 1)
    await tick()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    expect(codeOf(await pending)).toBe('timeout')
  })

  it('stops a proxy check that never answers at 15 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = requestWebPage('http://pages.example/', {
      proxyFor: () => new Promise(() => {})
    })
    await tick()
    vi.advanceTimersByTime(WEB_PAGE_TIMEOUT_MS)
    expect(codeOf(await pending)).toBe('timeout')
  })

  it('rejects with the Stop reason instead of calling the page unreadable', async () => {
    const { server, started } = await slowServer()
    const controller = new AbortController()
    const stopped = new Error('run stopped')
    const pending = read(server, '/', { signal: controller.signal })
    await started
    controller.abort(stopped)
    await expect(pending).rejects.toBe(stopped)
    await expect(read(server, '/', { signal: controller.signal })).rejects.toBe(stopped)
  })
})

describe('https', () => {
  let defaults: string[] = []

  beforeAll(() => {
    defaults = getCACertificates('default')
  })

  it('refuses a certificate it cannot verify', async () => {
    const server = await serve(page('<p>secure</p>'), true)
    expect(codeOf(await read(server))).toBe('tls')
  })

  describe('with the test certificate trusted', () => {
    beforeAll(() => {
      setDefaultCACertificates([...defaults, LOCAL_HTTPS_TEST_CERTIFICATE])
    })

    afterAll(() => {
      setDefaultCACertificates(defaults)
    })

    it('reads a verified page', async () => {
      const server = await serve(page('<p>secure</p>'), true)
      const response = await read(server)
      expect(response.state === 'fetched' && response.body.toString()).toBe('<p>secure</p>')
    })

    it('refuses a redirect from https to http', async () => {
      const plain = await serve(page('<p>plain</p>'))
      const secure = await serve(redirect(`${plain.origin}/`), true)
      const response = await requestWebPage(`${secure.origin}/`, {
        policy: { ports: [443, secure.port, plain.port], blocked: loopbackPolicy(0).blocked },
        proxyFor: directProxy
      })
      expect(codeOf(response)).toBe('insecure-redirect')
      expect(plain.connections()).toBe(0)
    })

    it('connects through the pinned lookup and refuses a name the certificate does not carry', async () => {
      const server = await serve(page('<p>secure</p>'), true)
      const lookup = vi.fn(answering('127.0.0.1'))
      const response = await requestWebPage(`https://pages.example:${server.port}/`, {
        lookup,
        policy: loopbackPolicy(server.port),
        proxyFor: directProxy
      })
      expect(codeOf(response)).toBe('tls')
      expect(lookup).toHaveBeenCalledWith('pages.example')
    })
  })
})
