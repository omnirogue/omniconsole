import { describe, expect, it } from 'vitest'
import type { LaunchPlacementRoute } from '../shared/agent-launch-placement-types'
import {
  chooseLaunchSetup,
  classifyLaunchCandidate,
  launchRouteSetups,
  type LaunchCandidateFacts
} from './launch-candidate-state'
import {
  NEW_RUNTIME_CAPABILITIES,
  NOW,
  OMNI_IDE,
  launchLoad,
  projectSetup,
  readinessResult
} from './launch-capacity-test-fixtures'

const ENV: LaunchPlacementRoute = { kind: 'environment', environmentId: 'env-2586', name: 'mw0002' }

function facts(change: Partial<LaunchCandidateFacts> = {}): LaunchCandidateFacts {
  return {
    route: ENV,
    label: 'mw0002',
    isThisComputer: false,
    checkedAt: NOW,
    provider: 'claude',
    project: OMNI_IDE,
    status: {
      ok: true,
      runtimeId: 'rt-1',
      appVersion: '1.13.0',
      capabilities: NEW_RUNTIME_CAPABILITIES,
      sessionHostId: 'host-2586'
    },
    setups: { ok: true, setups: [projectSetup()] },
    readiness: { ok: true, result: readinessResult() },
    ...change
  }
}

describe('launch candidate setups', () => {
  it("takes a paired computer's own setups, stamped local or with its runtime id", () => {
    const { own, nested } = launchRouteSetups(
      [
        projectSetup({ id: 'a' }),
        projectSetup({ id: 'b', hostId: 'runtime:env-2586' }),
        projectSetup({ id: 'c', hostId: 'runtime:env-other' }),
        projectSetup({ id: 'd', hostId: 'ssh:ssh-behind' }),
        projectSetup({ id: 'e', setupState: 'setting-up' })
      ],
      ENV
    )
    expect(own.map((setup) => setup.id)).toEqual(['a', 'b'])
    expect(nested.map((setup) => setup.id)).toEqual(['d'])
  })

  it('prefers a git setup, then the oldest, and resolves it by its main worktree id', () => {
    const chosen = chooseLaunchSetup([
      projectSetup({ id: 'folder', kind: 'folder', createdAt: NOW - 9e9, path: '/w/notes' }),
      projectSetup({ id: 'newer', createdAt: NOW - 1_000, path: '/w/newer' }),
      projectSetup({ id: 'older', createdAt: NOW - 5_000, path: '/w/older' })
    ])
    expect(chosen).toMatchObject({ kind: 'git', repoId: 'repo-1', selector: 'id:repo-1::/w/older' })
    expect(chooseLaunchSetup([projectSetup({ kind: 'folder', path: '/w/notes' })])).toMatchObject({
      kind: 'folder',
      selector: 'path:/w/notes'
    })
  })
})

describe('classifyLaunchCandidate', () => {
  it('is fresh only when every check passes, deduped by the readiness machine id', () => {
    const candidate = classifyLaunchCandidate(
      facts({ readiness: { ok: true, result: readinessResult({ machineId: 'mach-2586' }) } })
    )
    expect(candidate).toMatchObject({
      state: 'fresh',
      machineId: 'mach-2586',
      hostId: 'local',
      runtimeId: 'rt-1',
      setupCount: 1,
      reason: '72% left on a@example.com'
    })
    // Why: without a readiness machine id the runtime's own session host id still dedupes it.
    expect(classifyLaunchCandidate(facts()).machineId).toBe('host-2586')
  })

  it("never takes an SSH route's machine id from this computer's status", () => {
    const ssh: LaunchPlacementRoute = { kind: 'ssh', targetId: 'ssh-1', label: 'box' }
    const candidate = classifyLaunchCandidate(
      facts({
        route: ssh,
        label: 'box',
        setups: { ok: true, setups: [projectSetup({ hostId: 'ssh:ssh-1' })] },
        readiness: {
          ok: true,
          result: readinessResult({
            workspace: { ...readinessResult().workspace, hostId: 'ssh:ssh-1' }
          })
        }
      })
    )
    expect(candidate).toMatchObject({ state: 'fresh', machineId: null, appVersion: null })
  })

  it("reads a Windows runtime's load as unknown, since its load average is always 0", () => {
    const windows = { ...facts().status, hostPlatform: 'win32' } as LaunchCandidateFacts['status']
    const candidate = classifyLaunchCandidate(facts({ status: windows }))
    expect(candidate).toMatchObject({ state: 'fresh', load: null })
    expect(candidate.reason).toContain('load unknown')
    // Why: an SSH route's reading comes from the SSH host, not this computer's platform.
    const ssh: LaunchPlacementRoute = { kind: 'ssh', targetId: 'ssh-1', label: 'box' }
    const viaSsh = classifyLaunchCandidate(
      facts({
        route: ssh,
        label: 'box',
        status: windows,
        setups: { ok: true, setups: [projectSetup({ hostId: 'ssh:ssh-1' })] },
        readiness: {
          ok: true,
          result: readinessResult({
            workspace: { ...readinessResult().workspace, hostId: 'ssh:ssh-1' }
          })
        }
      })
    )
    expect(viaSsh.load).toEqual(launchLoad(0.3))
  })

  it('is unverifiable when readiness answers for another runtime or another host', () => {
    const restarted = classifyLaunchCandidate(
      facts({ readiness: { ok: true, result: readinessResult({ runtimeId: 'rt-after-restart' }) } })
    )
    expect(restarted).toMatchObject({
      state: 'unverifiable',
      reason: 'restarted while it was being read (unverifiable)'
    })
    // Why: a rejected answer describes nothing about this route, so none of its readings show.
    expect(restarted).toMatchObject({ hostId: null, account: null, load: null })
    const elsewhere = classifyLaunchCandidate(
      facts({
        readiness: {
          ok: true,
          result: readinessResult({
            workspace: { ...readinessResult().workspace, hostId: 'ssh:ssh-9' },
            machineId: 'mach-9'
          })
        }
      })
    )
    expect(elsewhere).toMatchObject({
      state: 'unverifiable',
      reason: 'its setup resolves to ssh:ssh-9, not this route (unverifiable)'
    })
    expect(elsewhere).toMatchObject({
      hostId: null,
      account: null,
      load: null,
      machineId: 'host-2586'
    })
  })

  it('never launches into a git setup without a repository record, and says why', () => {
    const candidate = classifyLaunchCandidate(
      facts({ setups: { ok: true, setups: [projectSetup({ repoId: '' })] }, readiness: null })
    )
    expect(candidate).toMatchObject({ state: 'no-setup', setup: null, setupCount: 1 })
    expect(candidate.reason).toBe(
      'its ready setup of github:omnirogue/omni-ide has no repository record here; set it up again in the desktop app'
    )
    // Why: a folder setup launches by path, so it needs no repository record.
    const folder = classifyLaunchCandidate(
      facts({
        setups: { ok: true, setups: [projectSetup({ repoId: '', kind: 'folder', path: '/w/n' })] },
        readiness: {
          ok: true,
          result: readinessResult({
            workspace: { ...readinessResult().workspace, kind: 'folder' }
          })
        }
      })
    )
    expect(folder).toMatchObject({ state: 'fresh', setup: { selector: 'path:/w/n' } })
  })

  it('names each exclusion', () => {
    const states = {
      old: classifyLaunchCandidate(
        facts({
          status: {
            ok: true,
            runtimeId: 'rt-1',
            appVersion: '1.12.18',
            capabilities: [],
            sessionHostId: null
          }
        })
      ),
      noSetup: classifyLaunchCandidate(facts({ setups: { ok: true, setups: [] } })),
      nested: classifyLaunchCandidate(
        facts({ setups: { ok: true, setups: [projectSetup({ hostId: 'ssh:ssh-behind' })] } })
      ),
      noCreate: classifyLaunchCandidate(
        facts({
          status: {
            ok: true,
            runtimeId: 'rt-1',
            appVersion: '1.13.0',
            capabilities: [NEW_RUNTIME_CAPABILITIES[0]!],
            sessionHostId: null
          }
        })
      ),
      unverified: classifyLaunchCandidate(
        facts({
          readiness: {
            ok: true,
            result: readinessResult({
              account: {
                verified: false,
                refusal: 'No claude account … Nothing launched.',
                accounts: [
                  { label: 'a', state: 'limited', reason: 'weekly window exhausted' },
                  { label: 'b', state: 'stale', reason: 'reading 90 s old' },
                  { label: 'c', state: 'stale', reason: 'reading 95 s old' }
                ]
              }
            })
          }
        })
      ),
      hot: classifyLaunchCandidate(
        facts({ readiness: { ok: true, result: readinessResult({ load: launchLoad(0.91) }) } })
      ),
      late: classifyLaunchCandidate(
        facts({
          readiness: {
            ok: false,
            reason: 'did not answer within 30 s (unverifiable)',
            unreachable: true
          }
        })
      )
    }
    expect(states.old).toMatchObject({ state: 'old-runtime', launchCapability: false })
    expect(states.old.reason).toBe(
      'OmniConsole 1.12.18: launch needs OmniConsole update (no agent-session.verified-account-launch.v1)'
    )
    expect(states.noSetup).toMatchObject({ state: 'no-setup' })
    expect(states.noSetup.reason).toContain(
      'omni project setup-clone --project github:omnirogue/omni-ide --host runtime:env-2586'
    )
    expect(states.nested.state).toBe('nested-ssh')
    expect(states.noCreate.state).toBe('no-idempotent-create')
    expect(states.unverified).toMatchObject({
      state: 'unverified-account',
      reason: 'no claude account with fresh verified capacity (limited 1, stale 2)'
    })
    expect(states.hot).toMatchObject({ state: 'hot', reason: '0.91 load per core (hot)' })
    expect(states.late).toMatchObject({ state: 'unverifiable', reachable: false, account: null })
  })

  it("does not match another computer's setups to this computer's own repo: id", () => {
    const hostLocal = { input: 'repo:abc', identityKey: 'repo:abc', name: null }
    const candidate = classifyLaunchCandidate(
      facts({
        project: hostLocal,
        setups: { ok: true, setups: [projectSetup({ projectId: 'repo:abc' })] }
      })
    )
    expect(candidate).toMatchObject({ state: 'no-setup', setupCount: 0 })
    expect(candidate.reason).toContain("this computer's own project id")
  })
})
