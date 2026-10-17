import { describe, expect, it, vi } from 'vitest'
import { probeAcpLaunch } from './acp-launch-probe'
import { fakeConnection } from './acp-test-connection'
import { ACP_STRUCTURED_AGENTS, acpSpawnRecipe } from '../../shared/acp-agent-recipes'

describe('ACP launch admission', () => {
  it.each(ACP_STRUCTURED_AGENTS)(
    'probes the exact %s recipe and proves child exit',
    async (agent) => {
      const connection = fakeConnection({})
      const openConnection = vi.fn(async () => connection)
      const result = await probeAcpLaunch({
        agent,
        cwd: '/workspace',
        env: {},
        findCommand: (name) => `/bin/${name}`,
        openConnection
      })
      const recipe = acpSpawnRecipe(agent)!
      expect(openConnection).toHaveBeenCalledWith({
        command: `/bin/${recipe.program}`,
        args: recipe.args,
        cwd: '/workspace',
        env: {}
      })
      expect(result).toEqual({ supported: true })
    }
  )

  it('does not spawn when the binary is missing', async () => {
    const openConnection = vi.fn()
    expect(
      await probeAcpLaunch({
        agent: 'goose',
        cwd: '/workspace',
        env: {},
        findCommand: () => null,
        openConnection
      })
    ).toEqual({ supported: false, reason: 'binary-missing', detail: 'goose' })
    expect(openConnection).not.toHaveBeenCalled()
  })

  it('requires Bun before launching OMP', async () => {
    const openConnection = vi.fn()
    expect(
      await probeAcpLaunch({
        agent: 'omp',
        cwd: '/workspace',
        env: {},
        findCommand: (name) => (name === 'bun' ? null : '/bin/omp'),
        openConnection
      })
    ).toEqual({ supported: false, reason: 'bun-missing', detail: 'bun' })
    expect(openConnection).not.toHaveBeenCalled()
  })

  it('fails closed on initialize errors and on unproven child exit', async () => {
    const input = { agent: 'goose', cwd: '/workspace', env: {}, findCommand: () => '/bin/goose' }
    expect(
      await probeAcpLaunch({
        ...input,
        openConnection: async () => {
          throw new Error('unsupported flag --acp')
        }
      })
    ).toEqual({ supported: false, reason: 'initialize-failed', detail: 'unsupported flag --acp' })
    const connection = fakeConnection({})
    connection.close = async () => false
    expect(await probeAcpLaunch({ ...input, openConnection: async () => connection })).toEqual({
      supported: false,
      reason: 'exit-unproven'
    })
  })
})
