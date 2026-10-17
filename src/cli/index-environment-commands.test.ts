import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/omni-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY } from '../shared/protocol-version'

describe('omni cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('lists saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    listEnvironmentsMock.mockReturnValue([addEnvironmentFromPairingCodeMock()])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['environment', 'list', '--json'], '/tmp/repo')

    expect(listEnvironmentsMock).toHaveBeenCalledWith('/tmp/omni-user-data')
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })

  it('adds saved environments even when ORCA_ENVIRONMENT is set', async () => {
    process.env.ORCA_ENVIRONMENT = 'stale-env'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['environment', 'add', '--name', 'desk', '--pairing-code', 'omni://pair#abc', '--json'],
      '/tmp/repo'
    )

    expect(addEnvironmentFromPairingCodeMock).toHaveBeenCalledWith('/tmp/omni-user-data', {
      name: 'desk',
      pairingCode: 'omni://pair#abc'
    })
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('token')
    expect(logSpy.mock.calls[0]?.[0]).not.toContain('publicKeyB64')
  })
})

describe('omni session launch --host routing', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  function answerLaunchHost(): void {
    callMock.mockImplementation(async (method: string, params?: { preview?: boolean }) => {
      const result =
        method === 'ssh.listTargetSummaries'
          ? { targets: [] }
          : method === 'status.get'
            ? {
                runtimeId: '11111111-1111-4111-8111-111111111111',
                appVersion: '1.12.19',
                capabilities: [AGENT_SESSION_VERIFIED_ACCOUNT_LAUNCH_RUNTIME_CAPABILITY]
              }
            : {
                runtimeId: '11111111-1111-4111-8111-111111111111',
                workspace: { id: 'repo::/w', hostId: 'local', kind: 'git', path: '/w', name: null },
                ...(params?.preview
                  ? { account: { verified: false, refusal: 'none', accounts: [] } }
                  : {})
              }
      return {
        id: 'r',
        ok: true,
        result,
        _meta: { runtimeId: '11111111-1111-4111-8111-111111111111' }
      }
    })
  }

  it('session launch --host "Mac Studio" routes to that environment', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-studio', 'Mac Studio')
    answerLaunchHost()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'session',
        'launch',
        '--provider',
        'codex',
        '--host',
        'Mac Studio',
        '--worktree',
        'id:repo::/w',
        '--prompt',
        'Do the work.',
        '--dry-run',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, 'env-studio')
    expect(callMock).toHaveBeenCalledWith(
      'terminal.agentLaunchReadiness',
      { worktree: 'id:repo::/w', agent: 'codex', preview: true },
      { timeoutMs: 20_000 }
    )
    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(printed.result).toMatchObject({ launched: false, host: { route: 'paired' } })
  })

  it('--host auto reaches the launch refusal instead of the host-id parser', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['session', 'launch', '--provider', 'codex', '--host', 'auto', '--prompt', 'x', '--json'],
      '/tmp/repo'
    )

    const printed = String(logSpy.mock.calls.at(-1)?.[0])
    expect(printed).toContain('--host auto arrives with automatic placement')
    expect(printed).not.toContain('Invalid --host value')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  /** Every computer answers as an older runtime, so a placement dry run refuses R17 by name. */
  function answerPlacementReads(): void {
    const results: Record<string, unknown> = {
      'project.list': { projects: [] },
      'ssh.listTargetSummaries': { targets: [] },
      'status.get': {
        runtimeId: '11111111-1111-4111-8111-111111111111',
        appVersion: '1.12.18',
        capabilities: []
      },
      'projectHostSetup.list': { setups: [] }
    }
    callMock.mockImplementation(async (method: string) => ({
      id: 'r',
      ok: true,
      result: results[method],
      _meta: { runtimeId: '11111111-1111-4111-8111-111111111111' }
    }))
  }

  function placementDryRun(host: string): string[] {
    return [
      'session',
      'launch',
      '--provider',
      'claude',
      '--project',
      'github:x/y',
      '--host',
      host,
      '--prompt',
      'x',
      '--dry-run',
      '--json'
    ]
  }

  it('--project with a computer name keeps --host as typed for placement to narrow', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-2586', 'mw0002')
    answerPlacementReads()
    runtimeClientConstructorMock.mockClear()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    process.exitCode = undefined

    await main(placementDryRun('mw0002'), '/tmp/repo')

    // Why one: placement's own client reaches mw0002; the router built no routed client for it.
    expect(
      runtimeClientConstructorMock.mock.calls.filter(
        ([, environment]) => environment === 'env-2586'
      )
    ).toHaveLength(1)
    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(printed.result.wouldRefuse.code).toBe('launch_no_computer')
    expect(printed.result.candidates).toEqual([
      expect.objectContaining({
        label: 'mw0002',
        route: { kind: 'environment', environmentId: 'env-2586', name: 'mw0002' },
        state: 'old-runtime'
      })
    ])
    expect(process.exitCode).toBeUndefined()
    process.exitCode = priorExitCode
  })

  it('--project with --host auto places instead of reaching the host-id parser', async () => {
    answerPlacementReads()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    process.exitCode = undefined

    await main(placementDryRun('auto'), '/tmp/repo')

    const output = String(logSpy.mock.calls.at(-1)?.[0])
    expect(output).not.toContain('Invalid --host value')
    expect(output).not.toContain('--host auto arrives with automatic placement')
    const printed = JSON.parse(output)
    expect(printed.result.wouldRefuse.code).toBe('launch_no_computer')
    expect(printed.result.candidates.map((entry: { label: string }) => entry.label)).toEqual([
      'this computer'
    ])
    expect(callMock).toHaveBeenCalledWith('project.list', undefined, expect.anything())
    expect(process.exitCode).toBeUndefined()
    process.exitCode = priorExitCode
  })

  it('other commands still parse --host as before', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-studio', 'Mac Studio')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['project', 'setups', '--host', 'Mac Studio', '--json'], '/tmp/repo')
    // With a server already selected, a launch keeps the explicit-forms-only rule too.
    await main(
      [
        'session',
        'launch',
        '--provider',
        'codex',
        '--environment',
        'Mac Studio',
        '--host',
        'Mac Studio',
        '--prompt',
        'x',
        '--json'
      ],
      '/tmp/repo'
    )

    const output = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
    expect(output.match(/Invalid --host value: Mac Studio/g)).toHaveLength(2)
    expect(callMock).not.toHaveBeenCalled()
    process.exitCode = priorExitCode
  })
})
