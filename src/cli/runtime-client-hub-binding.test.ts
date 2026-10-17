import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY
} from '../shared/protocol-version'
import { RuntimeClient } from './runtime/client'

type Request = { id: string; method: string; params?: unknown }
type TestHost = {
  client: RuntimeClient
  requestsByConnection: Request[][]
  close: () => Promise<void>
}

const hosts: TestHost[] = []
const contractCapabilities = [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY]
const boundParams = { objective: 'Execute admitted work', hubTaskId: 'btk_cligate' }
const unsupportedCapability = {
  code: 'unsupported_runtime_capability',
  data: {
    capability: ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY,
    effectsApplied: false
  }
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
})

describe('CLI hub-bound run admission capability', () => {
  it('refuses a contract-capable older host before sending bound runCreate', async () => {
    const host = await startHost(() => ({ capabilities: contractCapabilities }))

    await expect(host.client.call('orchestration.runCreate', boundParams)).rejects.toMatchObject(
      unsupportedCapability
    )

    expect(methodsByConnection(host)).toEqual([['status.get'], ['status.get']])
  })

  it('checks each new connection across a host upgrade and subsequent downgrade', async () => {
    const capabilities: string[] = [...contractCapabilities]
    const host = await startHost(() => ({ capabilities }))

    await expect(host.client.call('orchestration.runCreate', boundParams)).rejects.toMatchObject(
      unsupportedCapability
    )
    capabilities.push(ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY)
    await expect(host.client.call('orchestration.runCreate', boundParams)).resolves.toMatchObject({
      ok: true,
      result: { admitted: true }
    })
    capabilities.pop()
    await expect(host.client.call('orchestration.runCreate', boundParams)).rejects.toMatchObject(
      unsupportedCapability
    )

    expect(methodsByConnection(host)).toEqual([
      ['status.get'],
      ['status.get'],
      ['status.get', 'orchestration.runCreate'],
      ['status.get']
    ])
    expect(host.requestsByConnection[2]?.[1]?.params).toEqual(boundParams)
  })

  it('keeps unbound runCreate working on a host without hub binding support', async () => {
    const host = await startHost(() => ({ capabilities: contractCapabilities }))

    await expect(
      host.client.call('orchestration.runCreate', { objective: 'Ad hoc execution' })
    ).resolves.toMatchObject({ ok: true })

    expect(methodsByConnection(host)).toEqual([['status.get'], ['orchestration.runCreate']])
  })

  it.each([
    {
      name: 'failed status response',
      response: (request: Request) => ({
        id: request.id,
        ok: false,
        error: { code: 'status_unavailable', message: 'Host status is unavailable.' },
        _meta: { runtimeId: 'runtime-hub-gate' }
      }),
      code: 'status_unavailable'
    },
    {
      name: 'malformed response frame',
      response: () => '{invalid json',
      code: 'invalid_runtime_response'
    },
    {
      name: 'missing capabilities',
      response: (request: Request) => success(request.id, {}),
      code: 'unsupported_runtime_capability'
    },
    {
      name: 'non-array capabilities',
      response: (request: Request) =>
        success(request.id, { capabilities: ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY }),
      code: 'unsupported_runtime_capability'
    }
  ])('never mutates after a $name during the same-socket preflight', async ({ response, code }) => {
    const host = await startHost(
      () => ({ capabilities: contractCapabilities }),
      (request, statusCount) => (statusCount === 2 ? response(request) : undefined)
    )

    await expect(host.client.call('orchestration.runCreate', boundParams)).rejects.toMatchObject({
      code
    })

    expect(methodsByConnection(host)).toEqual([['status.get'], ['status.get']])
  })
})

function methodsByConnection(host: TestHost): string[][] {
  return host.requestsByConnection.map((requests) => requests.map((request) => request.method))
}

function success(id: string, result: unknown): unknown {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-hub-gate' } }
}

async function startHost(
  status: () => unknown,
  statusResponse?: (request: Request, statusCount: number) => unknown
): Promise<TestHost> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'omni-cli-hub-gate-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\omni-cli-hub-gate-${randomUUID()}`
      : join(userDataPath, 'runtime.sock')
  const sockets = new Set<Socket>()
  const requestsByConnection: Request[][] = []
  let statusCount = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const requests: Request[] = []
    requestsByConnection.push(requests)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)) as Request
        buffer = buffer.slice(newline + 1)
        requests.push(request)
        let response: unknown
        if (request.method === 'status.get') {
          statusCount += 1
          response = statusResponse?.(request, statusCount) ?? success(request.id, status())
        } else {
          response = success(request.id, { admitted: true })
        }
        socket.write(`${typeof response === 'string' ? response : JSON.stringify(response)}\n`)
        newline = buffer.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  writeFileSync(
    join(userDataPath, 'omni-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-hub-gate',
      pid: process.pid,
      transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }],
      authToken: 'test-token',
      startedAt: 1
    })
  )
  const host: TestHost = {
    client: new RuntimeClient(userDataPath, 1_000, null, null),
    requestsByConnection,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
  hosts.push(host)
  return host
}
