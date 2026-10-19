import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamMcpClient } from './mcp-client'

let server: Server | undefined
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  vi.restoreAllMocks()
})
it('initializes, authenticates whoami, waits and acks against a fake MCP server', async () => {
  const calls: { method: string; params: { name: string; arguments: unknown } }[] = []
  const headers: string[] = []
  server = createServer(async (request, response) => {
    headers.push(request.headers.authorization ?? '')
    if (request.method === 'DELETE') {
      response.writeHead(200).end()
      return
    }
    let body = ''
    for await (const chunk of request) {
      body += chunk
    }
    const call = JSON.parse(body)
    calls.push(call)
    if (!call.id) {
      response.writeHead(202).end()
      return
    }
    const result =
      call.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1' }
          }
        : {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  call.params.name === 'whoami'
                    ? { org_id: 'org-fake' }
                    : { messages: [], count: 0 }
                )
              }
            ]
          }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Mcp-Session-Id': 'fake-session'
    })
    response.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: call.id, result })}\n\n`
    )
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const client = new TeamMcpClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    'osc1.fake-test-key'
  )
  expect(await client.call('whoami', {})).toEqual({ org_id: 'org-fake' })
  await client.call('session_wait', { session_id: 'test', wait_seconds: 45 })
  await client.call('session_ack', { message_id: 'test-directive' })
  expect(calls.map((call) => call.method)).toEqual([
    'initialize',
    'notifications/initialized',
    'tools/call',
    'tools/call',
    'tools/call'
  ])
  await client.close()
  expect(headers.every((value) => value === 'Bearer osc1.fake-test-key')).toBe(true)
})
describe('error redaction', () => {
  it('does not log or surface transport errors that echo keys', async () => {
    const key = 'osc1.fake-test-key'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`Authorization: Bearer ${key}`)))
    try {
      await expect(
        new TeamMcpClient('https://team.example/mcp', key).call('whoami', {})
      ).rejects.toThrow('OmniSI could not connect')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
