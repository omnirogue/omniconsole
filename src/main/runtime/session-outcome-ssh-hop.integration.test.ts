import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  requireSessionOutcomeHost,
  sessionOutcomeChainForHost
} from '../../shared/session-outcome-routing'
import type { SessionChain } from '../../shared/session-chain-types'
import { remoteOutcomeFixture } from './session-outcome-remote-test-fixture'

// Opt-in acceptance: the dispatcher owns authenticated -L/-R SSH forwards, not fixture credentials.
it.skipIf(!process.env.ORCA_OUTCOME_SSH_HOP_PORT)(
  'commits and resumes through an authenticated SSH forwarding hop without replay',
  async () => {
    const serverPort = Number(process.env.ORCA_OUTCOME_SSH_SERVER_PORT)
    const tunnelPort = Number(process.env.ORCA_OUTCOME_SSH_HOP_PORT)
    expect(serverPort).toBeGreaterThan(0)
    expect(tunnelPort).not.toBe(serverPort)
    const f = await remoteOutcomeFixture(undefined, undefined, serverPort)
    try {
      f.connection.close()
      const endpoint = new URL(f.pairing.endpoint)
      endpoint.hostname = '127.0.0.1'
      endpoint.port = String(tunnelPort)
      const pairing = { ...f.pairing, endpoint: endpoint.toString() }
      const tunneled = f.connect(pairing)
      const target = { kind: 'environment' as const, environmentId: 'tunnel' }
      const runtimeId = requireSessionOutcomeHost(f.capabilities, target)
      const request = {
        chain: sessionOutcomeChainForHost(f.chain, target),
        outcomes: [f.outcome],
        source: 'user',
        expectedRevision: 0,
        expectedExecutionRuntimeId: runtimeId
      }
      const committed = await tunneled.request<{ chain: SessionChain }>(
        'sessionChain.commitOutcomes',
        request,
        10_000
      )
      expect(committed).toMatchObject({
        ok: true,
        result: { chain: { outcomeSet: { revision: 1 } } }
      })
      const saved = JSON.parse(readFileSync(join(f.host.workspace, '.omni', 'state.json'), 'utf8'))
      expect(saved.sessionChains[0].outcomeSet.revision).toBe(1)
      tunneled.close()
      f.host.service.dispose()
      for (let index = 0; index < 4; index += 1) {
        await f.host.service.tick()
        await f.host.settle()
      }
      expect(f.host.launched).toHaveLength(1)
      const reconnected = f.connect(pairing)
      await expect(
        reconnected.request(
          'sessionChain.outcomeProgress',
          {
            id: f.chain.id,
            expectedExecutionRuntimeId: runtimeId
          },
          10_000
        )
      ).resolves.toMatchObject({ ok: true, result: { lifecycle: 'complete' } })
      await expect(
        reconnected.request('sessionChain.commitOutcomes', request, 10_000)
      ).resolves.toMatchObject({ ok: false })
      await f.host.service.tick()
      expect(f.host.launched).toHaveLength(1)
    } finally {
      await f.dispose()
    }
  },
  30_000
)
