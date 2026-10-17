import { describe, expect, it, vi } from 'vitest'
import {
  canonicalizeLaunchHostFlag,
  cliLaunchHostNameDeps,
  launchFlagsAsTyped,
  launchHostAlsoReachableAs,
  launchHostFlagPlacesItself,
  readLaunchWorkspaceHostId,
  routedLaunchFlags,
  type LaunchHostNameDeps
} from './launch-host-name'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

const ENVIRONMENTS = [
  { id: '9a1b2c3d-0000-4000-8000-000000000001', name: 'Mac Studio' },
  { id: '9a1b2c3d-0000-4000-8000-000000000002', name: 'mw0002' }
]
const SSH_TARGETS = [
  { id: 'ssh-1759000000000-aa11', label: 'studio' },
  { id: 'ssh-1759000000000-bb22', label: 'mw0002' }
]

function deps(overrides: Partial<LaunchHostNameDeps> = {}): LaunchHostNameDeps {
  return {
    listEnvironments: async () => ENVIRONMENTS,
    listSshTargets: async () => SSH_TARGETS,
    localWorkspaceHostId: vi.fn(async () => null),
    serverSelected: false,
    ...overrides
  }
}

async function canonical(
  host: string,
  overrides: Partial<LaunchHostNameDeps> = {},
  extra: [string, string][] = []
): Promise<string | boolean | undefined> {
  const flags = new Map<string, string | boolean>([['host', host], ...extra])
  await canonicalizeLaunchHostFlag(flags, deps(overrides))
  return flags.get('host')
}

describe('canonicalizeLaunchHostFlag', () => {
  it('resolves local aliases, paired names and SSH labels', async () => {
    await expect(canonical('This Mac')).resolves.toBe('local')
    await expect(canonical('this computer')).resolves.toBe('local')
    // Why: `omni host list` names this computer "this machine".
    await expect(canonical('this machine')).resolves.toBe('local')
    await expect(canonical('This Machine')).resolves.toBe('local')
    await expect(canonical('Mac Studio')).resolves.toBe(`runtime:${ENVIRONMENTS[0]!.id}`)
    await expect(canonical('mac studio')).resolves.toBe(`runtime:${ENVIRONMENTS[0]!.id}`)
    await expect(canonical('studio')).resolves.toBe('ssh:ssh-1759000000000-aa11')
    // Explicit forms pass through; the router and handler resolve them as before.
    await expect(canonical('runtime:Mac Studio')).resolves.toBe('runtime:Mac Studio')
    await expect(canonical('ssh:studio')).resolves.toBe('ssh:studio')
    await expect(canonical('local')).resolves.toBe('local')
  })

  it('prefers the paired route when a name matches both, unless this computer resolves the worktree to that SSH target', async () => {
    const paired = `runtime:${ENVIRONMENTS[1]!.id}`
    const viaSsh = 'ssh:ssh-1759000000000-bb22'
    await expect(canonical('mw0002')).resolves.toBe(paired)
    expect(launchHostAlsoReachableAs(paired)).toEqual([viaSsh])

    const elsewhere = vi.fn(async () => 'local')
    await expect(
      canonical('mw0002', { localWorkspaceHostId: elsewhere }, [['worktree', 'id:repo::/w']])
    ).resolves.toBe(paired)
    expect(elsewhere).toHaveBeenCalledWith('id:repo::/w')

    const onTarget = vi.fn(async () => 'ssh:ssh-1759000000000-bb22')
    await expect(
      canonical('mw0002', { localWorkspaceHostId: onTarget }, [['worktree', 'path:/srv/app']])
    ).resolves.toBe(viaSsh)
    expect(launchHostAlsoReachableAs(viaSsh)).toEqual([paired])
    expect(launchHostAlsoReachableAs(paired)).toEqual([])

    // Why: a cwd shortcut names this computer's directory, never the SSH target's.
    const cwdShortcut = vi.fn(async () => 'ssh:ssh-1759000000000-bb22')
    await expect(
      canonical('mw0002', { localWorkspaceHostId: cwdShortcut }, [['worktree', 'current']])
    ).resolves.toBe(paired)
    expect(cwdShortcut).not.toHaveBeenCalled()
  })

  it('remembers --host as typed for the intent key and the retry command', async () => {
    const flags = new Map<string, string | boolean>([
      ['provider', 'codex'],
      ['host', 'Mac Studio'],
      ['title', 'T']
    ])
    expect(launchFlagsAsTyped(flags)).toBe(flags)
    await canonicalizeLaunchHostFlag(flags, deps())
    expect(flags.get('host')).toBe(`runtime:${ENVIRONMENTS[0]!.id}`)
    const typed = launchFlagsAsTyped(flags)
    expect([...typed]).toEqual([
      ['provider', 'codex'],
      ['host', 'Mac Studio'],
      ['title', 'T']
    ])
    // Another invocation's flags are never mistaken for this one's.
    const other = new Map<string, string | boolean>([['host', `runtime:${ENVIRONMENTS[0]!.id}`]])
    expect(launchFlagsAsTyped(other)).toBe(other)
  })

  it('refuses ambiguous and unknown names with known hosts and next steps', async () => {
    const twins = [
      { id: 'ssh-1', label: 'box' },
      { id: 'ssh-2', label: 'box' }
    ]
    const ambiguous = await canonical('box', { listSshTargets: async () => twins }).catch(
      (error: unknown) => error
    )
    expect(ambiguous).toBeInstanceOf(RuntimeClientError)
    expect(ambiguous).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Ambiguous computer in --host box'),
      data: {
        knownSshTargets: twins,
        nextSteps: ['Use --host ssh:ssh-1 for box.', 'Use --host ssh:ssh-2 for box.']
      }
    })
    const unknown = await canonical('nowhere').catch((error: unknown) => error)
    expect(unknown).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Unknown computer in --host nowhere'),
      data: {
        knownEnvironments: ENVIRONMENTS,
        knownSshTargets: SSH_TARGETS,
        nextSteps: expect.arrayContaining([
          'Run `omni host list` to see every computer you can name.'
        ])
      }
    })
  })

  it('refuses --host auto without --project, naming --project as the fix', async () => {
    await expect(canonical('auto')).rejects.toThrow('--host auto arrives with automatic placement')
    await expect(canonical('AUTO', { serverSelected: true })).rejects.toThrow(
      'which needs --project <name|id>'
    )
  })

  it('leaves --host as typed next to --project: placement resolves it against the fleet', async () => {
    const listEnvironments = vi.fn(async () => ENVIRONMENTS)
    const project: [string, string][] = [['project', 'github:omnirogue/omni-ide']]
    await expect(canonical('auto', { listEnvironments }, project)).resolves.toBe('auto')
    await expect(canonical('mw0002', { listEnvironments }, project)).resolves.toBe('mw0002')
    expect(listEnvironments).not.toHaveBeenCalled()
    expect(launchHostFlagPlacesItself(new Map(project))).toBe(true)
    expect(launchHostFlagPlacesItself(new Map([['host', 'auto']]))).toBe(false)
  })

  it('routes one step to a placed computer while the retry still reads the command as typed', () => {
    const typed = new Map<string, string | boolean>([
      ['provider', 'claude'],
      ['project', 'omni-ide'],
      ['host', 'auto'],
      ['prompt-file', 'brief.md']
    ])
    const routed = routedLaunchFlags(typed, {
      host: 'runtime:env-1',
      worktree: 'id:wt-1',
      project: undefined
    })
    expect(routed.get('host')).toBe('runtime:env-1')
    expect(routed.get('worktree')).toBe('id:wt-1')
    expect(routed.has('project')).toBe(false)
    expect(launchFlagsAsTyped(routed)).toBe(typed)
    expect(typed.get('host')).toBe('auto')
  })

  it('leaves names alone when --environment or a pairing code selects a server', async () => {
    const listEnvironments = vi.fn(async () => ENVIRONMENTS)
    await expect(canonical('Mac Studio', { serverSelected: true, listEnvironments })).resolves.toBe(
      'Mac Studio'
    )
    await expect(canonical('this mac', { serverSelected: true })).resolves.toBe('this mac')
    expect(listEnvironments).not.toHaveBeenCalled()
    const client = (() => ({ call: vi.fn() })) as unknown as () => RuntimeClient
    expect(
      cliLaunchHostNameDeps(new Map([['environment', 'Mac Studio']]), client, {}).serverSelected
    ).toBe(true)
    expect(
      cliLaunchHostNameDeps(new Map([['pairing-code', 'omni://pair#x']]), client, {}).serverSelected
    ).toBe(true)
    expect(
      cliLaunchHostNameDeps(new Map(), client, { ORCA_ENVIRONMENT: 'desk' }).serverSelected
    ).toBe(true)
    expect(cliLaunchHostNameDeps(new Map(), client, {}).serverSelected).toBe(false)
  })
})

describe('readLaunchWorkspaceHostId', () => {
  it("asks this computer's readiness read-only and treats any failure as unknown", async () => {
    const call = vi.fn(async () => ({ result: { workspace: { hostId: 'ssh:ssh-1' } } }))
    const client = { call } as unknown as RuntimeClient
    await expect(readLaunchWorkspaceHostId(client, 'id:w', 'codex')).resolves.toBe('ssh:ssh-1')
    expect(call).toHaveBeenCalledWith(
      'terminal.agentLaunchReadiness',
      { worktree: 'id:w', agent: 'codex', preview: false },
      { timeoutMs: 10_000 }
    )
    call.mockRejectedValueOnce(new RuntimeClientError('method_not_found', 'Unknown method'))
    await expect(readLaunchWorkspaceHostId(client, 'id:w', 'claude')).resolves.toBeNull()
    await expect(readLaunchWorkspaceHostId(client, 'id:w', 'gemini')).resolves.toBeNull()
  })
})
