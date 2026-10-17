import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WEB_PAGE_REASON_CODES, type WebPageReasonCode } from '../../shared/web-page-reason'
import { LOCAL_HTTPS_TEST_CERTIFICATE } from '../browser/browser-local-https-test-certificate'
import { blockedWebIp } from './web-address-policy'
import { readWebPage, type WebPageReading } from './web-page-reader'
import { WEB_PAGE_TIMEOUT_MS } from './web-page-request'
import { WEB_PAGE_MAX_BYTES } from './web-page-response'
import { webPageTextOffThread } from './web-page-text-runner'
import {
  directProxy,
  loopbackPolicy,
  startPageServer,
  type PageServer
} from './web-page-test-server'

// The worker entry only exists once bundled (the runner's own test bundles it); here the step runs inline.
vi.mock('./web-page-text-runner', async () => {
  const { webPageText } = await import('./web-page-text')
  return {
    webPageTextOffThread: vi.fn(async (body: Uint8Array, type: string, charset: string | null) =>
      webPageText(body, type, charset)
    )
  }
})

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const servers: PageServer[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function serve(handler: Handler, tls = false): Promise<PageServer> {
  const server = await startPageServer(handler, { tls })
  servers.push(server)
  return server
}

const page =
  (body: string | Buffer, type = 'text/html; charset=utf-8'): Handler =>
  (_request, response) => {
    response.writeHead(200, { 'Content-Type': type })
    response.end(body)
  }

const redirect =
  (location: string): Handler =>
  (_request, response) => {
    response.writeHead(302, { Location: location })
    response.end()
  }

async function readFrom(server: PageServer, path = '/'): Promise<WebPageReading> {
  return readWebPage(`${server.origin}${path}`, {
    policy: loopbackPolicy(server.port),
    proxyFor: directProxy
  })
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

describe('readWebPage', () => {
  it('reads a page into clean text and hashes both what was fetched and what is kept', async () => {
    const fixture = readFileSync(join(__dirname, '__fixtures__', 'hidden-instructions.html'))
    const server = await serve(page(fixture))
    const reading = await readFrom(server, '/guide')
    if (reading.state !== 'read') {
      throw new Error(`expected a read page, got ${JSON.stringify(reading)}`)
    }
    expect(reading.text).toContain('Clean the panels twice a year with soft water.')
    expect(reading.text).not.toContain('CANARY')
    expect(reading).toMatchObject({
      title: 'Solar panel care guide',
      finalUrl: `${server.origin}/guide`,
      redirects: [],
      contentType: 'text/html',
      bytes: fixture.length,
      rawSha256: sha256(fixture),
      textSha256: sha256(reading.text),
      removedLines: 1,
      truncated: false
    })
    expect(reading.raw.equals(fixture)).toBe(true)
  })

  it('refuses the same test server under the default policy, with no connection made', async () => {
    const server = await serve(page('<p>local</p>'))
    expect(await readWebPage(`${server.origin}/`)).toEqual({
      state: 'unreadable',
      reason: { code: 'port' },
      redirects: []
    })
    const withPortOnly = { ports: [80, 443, server.port], blocked: blockedWebIp }
    expect(await readWebPage(`${server.origin}/`, { policy: withPortOnly })).toMatchObject({
      reason: { code: 'private-address' }
    })
    const byName = await readWebPage(`http://pages.example:${server.port}/`, {
      policy: withPortOnly,
      proxyFor: directProxy,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }]
    })
    expect(byName).toMatchObject({ reason: { code: 'private-address' } })
    expect(server.connections()).toBe(0)
  })

  it('calls a page with no readable text empty, including one the text step gave up on', async () => {
    for (const body of ['', '   \n  ', '<html><body><p hidden>only hidden</p></body></html>']) {
      const server = await serve(page(body))
      expect(await readFrom(server)).toMatchObject({
        state: 'unreadable',
        reason: { code: 'empty' }
      })
    }
    vi.mocked(webPageTextOffThread).mockResolvedValueOnce(null)
    const server = await serve(page('<p>too hard to parse</p>'))
    expect(await readFrom(server)).toMatchObject({ reason: { code: 'empty' } })
  })

  it('rejects with the Stop reason rather than calling the page unreadable', async () => {
    const controller = new AbortController()
    const stopped = new Error('run stopped')
    controller.abort(stopped)
    await expect(readWebPage('https://pages.example/', { signal: controller.signal })).rejects.toBe(
      stopped
    )
  })
})

describe('every unreadable reason', () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

  const SCENARIOS: Record<WebPageReasonCode, () => Promise<WebPageReading>> = {
    scheme: () => readWebPage('ftp://pages.example/'),
    credentials: () => readWebPage('https://user:secret@pages.example/'),
    port: () => readWebPage('http://pages.example:8080/'),
    'private-address': () => readWebPage('http://169.254.169.254/latest/meta-data/'),
    dns: () =>
      readWebPage('https://pages.example/', {
        proxyFor: directProxy,
        lookup: async () => {
          throw Object.assign(new Error('no such host'), { code: 'ENOTFOUND' })
        }
      }),
    timeout: async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = readWebPage('https://pages.example/', {
        proxyFor: () => new Promise(() => {})
      })
      await tick()
      vi.advanceTimersByTime(WEB_PAGE_TIMEOUT_MS)
      return pending
    },
    'too-large': async () =>
      readFrom(await serve(page(Buffer.alloc(WEB_PAGE_MAX_BYTES + 1, 97), 'text/plain'))),
    'content-type': async () => readFrom(await serve(page('%PDF-1.7', 'application/pdf'))),
    status: async () =>
      readFrom(
        await serve((_request, response) => {
          response.writeHead(403)
          response.end('forbidden')
        })
      ),
    redirects: async () =>
      readFrom(
        await serve((request, response) =>
          redirect(request.url === '/' ? '/a' : '/')(request, response)
        )
      ),
    'insecure-redirect': async () => {
      const defaults = getCACertificates('default')
      setDefaultCACertificates([...defaults, LOCAL_HTTPS_TEST_CERTIFICATE])
      try {
        return await readFrom(await serve(redirect('http://pages.example/'), true))
      } finally {
        setDefaultCACertificates(defaults)
      }
    },
    tls: async () => readFrom(await serve(page('<p>secure</p>'), true)),
    proxy: () =>
      readWebPage('https://pages.example/', { proxyFor: async () => 'PROXY p.example:3128' }),
    network: async () => readFrom(await serve((request) => request.socket.destroy())),
    empty: async () => readFrom(await serve(page('')))
  }

  it.each(WEB_PAGE_REASON_CODES.map((code) => [code]))(
    'reads %s as unreadable, with the reason and no text',
    async (code) => {
      const reading = await SCENARIOS[code]()
      expect(reading.state).toBe('unreadable')
      expect(reading).not.toHaveProperty('text')
      expect(reading.state === 'unreadable' && reading.reason.code).toBe(code)
    }
  )
})
