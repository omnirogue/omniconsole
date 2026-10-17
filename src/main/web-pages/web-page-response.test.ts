import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { readWebPageResponse, WEB_PAGE_MAX_BYTES } from './web-page-response'
import { startPageServer, type PageServer } from './web-page-test-server'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const servers: PageServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

// Straight to the response reader, with no address policy or redirect handling in between.
async function answerFor(handler: Handler) {
  const server = await startPageServer(handler)
  servers.push(server)
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(`${server.origin}/`, { agent: false })
    outgoing.on('error', reject)
    outgoing.once('response', resolve)
    outgoing.end()
  })
  return readWebPageResponse(response)
}

const sending =
  (headers: Record<string, string>, body: string | Buffer = ''): Handler =>
  (_request, response) => {
    response.writeHead(200, headers)
    response.end(body)
  }

describe('readWebPageResponse', () => {
  it('reads the media type and charset, however the header is spelled', async () => {
    expect(
      await answerFor(sending({ 'Content-Type': 'Text/HTML ; Charset="ISO-8859-1"' }, 'x'))
    ).toEqual({
      kind: 'body',
      contentType: 'text/html',
      charset: 'iso-8859-1',
      body: Buffer.from('x')
    })
    expect(await answerFor(sending({ 'Content-Type': 'application/json' }, '{}'))).toMatchObject({
      kind: 'body',
      contentType: 'application/json',
      charset: null
    })
  })

  it.each([
    ['gzip', gzipSync('zipped')],
    ['x-gzip', gzipSync('zipped')],
    ['deflate', deflateSync('zipped')],
    ['identity', Buffer.from('zipped')]
  ])('decodes a %s body', async (encoding, body) => {
    const answer = await answerFor(
      sending({ 'Content-Type': 'text/plain', 'Content-Encoding': encoding }, body)
    )
    expect(answer.kind === 'body' && answer.body.toString()).toBe('zipped')
  })

  it('refuses a declared length over the cap before reading any of the body', async () => {
    const answer = await answerFor((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(WEB_PAGE_MAX_BYTES + 1)
      })
      response.write('a')
    })
    expect(answer).toEqual({ kind: 'refused', reason: { code: 'too-large' } })
  })

  it('hands back a redirect with its location, and refuses a redirect without one', async () => {
    expect(
      await answerFor((_request, response) => {
        response.writeHead(307, { Location: '/elsewhere' })
        response.end()
      })
    ).toEqual({ kind: 'redirect', location: '/elsewhere' })
    expect(
      await answerFor((_request, response) => {
        response.writeHead(301)
        response.end()
      })
    ).toEqual({ kind: 'refused', reason: { code: 'status', status: 301 } })
  })
})
