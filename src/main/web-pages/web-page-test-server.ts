import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server
} from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../browser/browser-local-https-test-certificate'
import { blockedWebIp, type WebAddressPolicy } from './web-address-policy'

export type SeenRequest = { method: string; path: string; headers: IncomingHttpHeaders }

/** A page server on an ephemeral 127.0.0.1 port, for tests only. */
export type PageServer = {
  origin: string
  port: number
  seen: SeenRequest[]
  connections: () => number
  close: () => Promise<void>
}

export async function startPageServer(
  handler: RequestListener,
  options: { tls?: boolean } = {}
): Promise<PageServer> {
  const seen: SeenRequest[] = []
  const sockets = new Set<Socket>()
  let connections = 0
  const listener: RequestListener = (request, response) => {
    seen.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers })
    handler(request, response)
  }
  const server: Server = options.tls
    ? createTlsServer(
        { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
        listener
      )
    : createServer(listener)
  server.on('connection', (socket: Socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  // A refused TLS handshake is the point of some tests, not a server failure.
  server.on('tlsClientError', () => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    seen,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolve())
      })
  }
}

/** Test-only: the default policy, except this server's port and `trust` visits to 127.0.0.1. */
export function loopbackPolicy(port: number, trust = Number.POSITIVE_INFINITY): WebAddressPolicy {
  let remaining = trust
  return {
    ports: [80, 443, port],
    blocked: (address) => {
      if (address === '127.0.0.1' && remaining > 0) {
        remaining -= 1
        return false
      }
      return blockedWebIp(address)
    }
  }
}

export const directProxy = async (): Promise<string> => 'DIRECT'
