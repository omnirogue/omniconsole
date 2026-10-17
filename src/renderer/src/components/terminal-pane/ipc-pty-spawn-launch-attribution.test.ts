import { describe, expect, it, vi } from 'vitest'
import { launchAttributionSpawnFields } from './ipc-pty-spawn-launch-attribution'
import type { LaunchTrigger } from '../../../../shared/launch-trigger'

const agentSpawn = { resumesAgentSession: true, hasStartupCommand: true }

describe('launchAttributionSpawnFields', () => {
  it('adds the pane description to an agent spawn', () => {
    const describeLaunch = vi.fn(() => ({ trigger: 'person-reveal' as const, visible: true }))
    expect(launchAttributionSpawnFields(describeLaunch, agentSpawn)).toEqual({
      launchTrigger: 'person-reveal',
      launchVisible: true
    })
    expect(describeLaunch).toHaveBeenCalledWith(agentSpawn)
  })

  it('describes bare shells and leaves unavailable descriptions unknown', () => {
    const describeLaunch = vi.fn(() => ({ trigger: 'new' as const, visible: true }))
    expect(
      launchAttributionSpawnFields(describeLaunch, { ...agentSpawn, hasStartupCommand: false })
    ).toEqual({ launchTrigger: 'new', launchVisible: true })
    expect(describeLaunch).toHaveBeenCalledOnce()
    expect(launchAttributionSpawnFields(undefined, agentSpawn)).toEqual({})
  })

  it('adds nothing when the description is unavailable or fails', () => {
    expect(launchAttributionSpawnFields(() => null, agentSpawn)).toEqual({})
    expect(
      launchAttributionSpawnFields(() => {
        throw new Error('store not ready')
      }, agentSpawn)
    ).toEqual({})
  })

  it('never forwards a value outside the fixed trigger tokens', () => {
    expect(
      launchAttributionSpawnFields(
        () => ({ trigger: 'ssh user@host' as LaunchTrigger, visible: 1 as unknown as boolean }),
        agentSpawn
      )
    ).toEqual({ launchTrigger: 'unknown', launchVisible: false })
  })
})
