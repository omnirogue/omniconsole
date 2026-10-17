import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './omni-runtime'
import { defineMethod } from './rpc/core'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

describe('Mobile E2EE request to runtime RPC MCP envelope', () => {
  it.each(['mobile', 'runtime'] as const)(
    'preserves the launch hint through the authenticated %s adapter',
    async (scope) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'omni-mcp-envelope-'))
      const launch = vi.fn(() => ({ accepted: true }))
      const runtime = {
        getRuntimeId: () => 'mcp-envelope-runtime',
        getStartedAt: () => 1,
        cleanupSubscriptionsForConnection: () => {},
        cancelMobileDictationForConnection: () => {},
        onClientDisconnected: () => {}
      } as unknown as OrcaRuntimeService
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        enableWebSocket: true,
        wsPort: 0,
        pinnedBindHost: '127.0.0.1',
        methods: [defineMethod({ name: 'terminal.create', params: null, handler: launch })]
      })
      const dispatch = vi.spyOn(server['dispatcher'], 'dispatchStreaming')
      let session: Awaited<ReturnType<typeof authenticateMobileWsSession>> | undefined
      let responses: ReturnType<typeof createEncryptedWsResponseReader> | undefined

      try {
        await server.start()
        const offer = server.createPairingOffer({ address: '127.0.0.1', name: 'mcp-test', scope })
        if (!offer.available) {
          throw new Error(`WebSocket pairing unavailable: ${offer.reason}`)
        }
        session = await authenticateMobileWsSession(offer.pairingUrl)
        responses = createEncryptedWsResponseReader(session)

        sendEncryptedWsRequest(session, {
          id: 'mobile-mcp-launch',
          method: 'terminal.create',
          omniConsoleMcpDefault: true
        })
        await expect(responses.next('mobile-mcp-launch')).resolves.toMatchObject({
          id: 'mobile-mcp-launch',
          ok: true,
          result: { accepted: true }
        })

        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'mobile-mcp-launch',
            method: 'terminal.create',
            omniConsoleMcpDefault: true
          }),
          expect.any(Function),
          expect.objectContaining({ clientKind: scope, connectionId: expect.any(String) })
        )
        expect(launch).toHaveBeenCalledOnce()
      } finally {
        responses?.dispose()
        session?.ws.close()
        await server.stop()
        dispatch.mockRestore()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )
})
