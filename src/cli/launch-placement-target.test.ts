import { describe, expect, it } from 'vitest'
import {
  launchPlacementHostFlag,
  launchPlacementRouteAllowed,
  resolveLaunchPlacementHostFilter
} from './launch-placement-target'
import { launchWorktreeName, launchWorktreeNameBase } from './launch-placement-worktree'

const ENVIRONMENTS = [
  { id: 'env-studio', name: 'Mac Studio' },
  { id: 'env-2586', name: 'mw0002' }
]
const SSH_TARGETS = [
  { id: 'ssh-2586', label: 'mw0002' },
  { id: 'ssh-studio', label: 'studio' }
]

describe('resolveLaunchPlacementHostFilter', () => {
  it('auto or no --host reads every computer', () => {
    expect(resolveLaunchPlacementHostFilter(undefined, ENVIRONMENTS, SSH_TARGETS)).toBeNull()
    expect(resolveLaunchPlacementHostFilter(' AUTO ', ENVIRONMENTS, SSH_TARGETS)).toBeNull()
  })

  it('a name keeps every route to that one computer, paired and SSH alike', () => {
    const filter = resolveLaunchPlacementHostFilter('mw0002', ENVIRONMENTS, SSH_TARGETS)!
    expect([...filter.environmentIds, ...filter.sshTargetIds]).toEqual(['env-2586', 'ssh-2586'])
    expect(launchPlacementRouteAllowed(filter, { kind: 'local' })).toBe(false)
    expect(
      launchPlacementRouteAllowed(filter, { kind: 'ssh', targetId: 'ssh-studio', label: 'studio' })
    ).toBe(false)
    const local = resolveLaunchPlacementHostFilter('this computer', ENVIRONMENTS, SSH_TARGETS)!
    expect(launchPlacementRouteAllowed(local, { kind: 'local' })).toBe(true)
    const explicit = resolveLaunchPlacementHostFilter(
      'runtime:Mac Studio',
      ENVIRONMENTS,
      SSH_TARGETS
    )!
    expect([...explicit.environmentIds, ...explicit.sshTargetIds]).toEqual(['env-studio'])
    expect(
      resolveLaunchPlacementHostFilter('ssh:studio', ENVIRONMENTS, SSH_TARGETS)!.sshTargetIds
    ).toEqual(new Set(['ssh-studio']))
  })

  it('refuses a name no computer has, with the known hosts', () => {
    expect(() => resolveLaunchPlacementHostFilter('nowhere', ENVIRONMENTS, SSH_TARGETS)).toThrow(
      'Unknown computer in --host nowhere'
    )
  })
})

describe('launchPlacementHostFlag', () => {
  it('names a computer by a unique name, else by its exact id', () => {
    expect(launchPlacementHostFlag({ kind: 'local' }, ENVIRONMENTS, SSH_TARGETS)).toBe('local')
    expect(
      launchPlacementHostFlag(
        { kind: 'environment', environmentId: 'env-studio', name: 'Mac Studio' },
        ENVIRONMENTS,
        SSH_TARGETS
      )
    ).toBe('Mac Studio')
    // Why: mw0002 is also an SSH label, so the name alone would reach both routes.
    expect(
      launchPlacementHostFlag(
        { kind: 'environment', environmentId: 'env-2586', name: 'mw0002' },
        ENVIRONMENTS,
        SSH_TARGETS
      )
    ).toBe('runtime:env-2586')
    expect(
      launchPlacementHostFlag(
        { kind: 'ssh', targetId: 'ssh-studio', label: 'studio' },
        ENVIRONMENTS,
        SSH_TARGETS
      )
    ).toBe('studio')
  })
})

describe('launch worktree names', () => {
  it('uses --name, else the title, else the first line of the brief, plus the operation suffix', () => {
    const operationId = '1800000000000-0123456789abcdef0123456789abcdef'
    expect(
      launchWorktreeName(
        launchWorktreeNameBase({ prompt: 'x', worktreeName: 'Login Fix' }),
        operationId
      )
    ).toBe('login-fix-abcdef')
    expect(
      launchWorktreeName(
        launchWorktreeNameBase({ prompt: 'x', title: 'Fix the timeout!' }),
        operationId
      )
    ).toBe('fix-the-timeout-abcdef')
    expect(
      launchWorktreeName(
        launchWorktreeNameBase({ prompt: '\n  Audit the ad spend\nDetails' }),
        operationId
      )
    ).toBe('audit-the-ad-spend-abcdef')
    expect(launchWorktreeName(launchWorktreeNameBase({ prompt: '🚀' }), operationId)).toBe(
      'launch-abcdef'
    )
  })
})
