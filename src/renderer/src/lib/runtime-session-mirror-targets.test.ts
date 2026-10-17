import { describe, expect, it } from 'vitest'
import { getReachableRuntimeSessionMirrorTargets } from './runtime-session-mirror-targets'

const environments = [
  {
    id: 'online-env',
    createdAt: 100,
    pairingRevision: 101
  },
  {
    id: 'offline-env',
    createdAt: 200
  }
]

describe('getReachableRuntimeSessionMirrorTargets', () => {
  it('mirrors saved reachable hosts before any environment or workspace is selected', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: null },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          [
            'online-env',
            {
              status: { runtimeId: 'runtime-online' },
              connectionGeneration: 3
            }
          ],
          ['offline-env', { status: null, connectionGeneration: 7 }]
        ])
      })
    ).toEqual([
      {
        environmentId: 'online-env',
        runtimeId: 'runtime-online',
        connectionGeneration: 3,
        pairingRevision: 101
      }
    ])
  })

  it('does not mirror removed environments with stale status or saved workspace references', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'online-env' },
        repos: [{ id: 'old-repo', connectionId: null, executionHostId: 'runtime:online-env' }],
        restoredRuntimeHostIdByWorkspaceSessionKey: { 'folder:old': 'runtime:online-env' },
        runtimeEnvironments: environments.filter((environment) => environment.id !== 'online-env'),
        runtimeStatusByEnvironmentId: new Map([
          ['online-env', { status: { runtimeId: 'runtime-online' }, connectionGeneration: 3 }]
        ])
      })
    ).toEqual([])
  })

  it('subscribes only after a runtime health probe succeeds', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'online-env' },
        repos: [{ id: 'offline-repo', connectionId: null, executionHostId: 'runtime:offline-env' }],
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          [
            'online-env',
            {
              status: { runtimeId: 'runtime-online' },
              connectionGeneration: 3
            }
          ],
          ['offline-env', { status: null, connectionGeneration: 7 }]
        ])
      })
    ).toEqual([
      {
        environmentId: 'online-env',
        runtimeId: 'runtime-online',
        connectionGeneration: 3,
        pairingRevision: 101
      }
    ])
  })

  it('waits for both the saved environment and its first successful status', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'online-env' },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map()
      })
    ).toEqual([])

    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'missing-env' },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          ['missing-env', { status: { runtimeId: 'runtime-missing' } }]
        ])
      })
    ).toEqual([])
  })

  it('uses creation time for environments paired before pairing revisions existed', () => {
    expect(
      getReachableRuntimeSessionMirrorTargets({
        settings: { activeRuntimeEnvironmentId: 'offline-env' },
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: new Map([
          ['offline-env', { status: { runtimeId: 'runtime-recovered' } }]
        ])
      })
    ).toEqual([
      {
        environmentId: 'offline-env',
        runtimeId: 'runtime-recovered',
        connectionGeneration: 0,
        pairingRevision: 200
      }
    ])
  })
})
