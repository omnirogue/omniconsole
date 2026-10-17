import { describe, expect, it } from 'vitest'
import type { AgentLaunchAccountReceipt, AgentLaunchLoad } from './agent-launch-account'
import {
  launchCandidateSummary,
  launchPlacementRefusal,
  rankLaunchCandidates
} from './agent-launch-placement'
import type { LaunchCandidate, LaunchPlacementRoute } from './agent-launch-placement-types'
import { hostLoadBand } from './host-resource-model'

const NOW = 1_800_000_000_000
const CONTEXT = { provider: 'claude' as const, project: 'github:omnirogue/omni-ide' }

function receipt(remainingPercent: number): AgentLaunchAccountReceipt {
  return {
    policy: 'best-verified',
    hostId: 'local',
    provider: 'claude',
    label: 'a@example.com',
    choiceId: 'managed:a',
    remainingPercent,
    boundBy: 'weekly',
    readingAt: NOW - 5_000,
    readingAgeMs: 5_000,
    fableVerified: false,
    verified: 1,
    considered: 1,
    excluded: [],
    why: 'most fresh verified headroom'
  }
}

function load(loadPerCore: number): AgentLaunchLoad {
  return { loadPerCore, band: hostLoadBand(loadPerCore), liveSessions: 1, observedAt: NOW }
}

function environment(name: string): LaunchPlacementRoute {
  return { kind: 'environment', environmentId: `env-${name}`, name }
}

/** An eligible candidate unless a change says otherwise. */
function candidate(
  label: string,
  percent: number,
  loadPerCore: number | null,
  change: Partial<LaunchCandidate> = {}
): LaunchCandidate {
  return {
    machineId: `machine-${label}`,
    label,
    route: environment(label),
    isThisComputer: false,
    appVersion: '1.13.0',
    launchCapability: true,
    idempotentCreate: true,
    reachable: true,
    checkedAt: NOW,
    runtimeId: `rt-${label}`,
    hostId: 'local',
    state: 'fresh',
    reason: '',
    setup: {
      projectId: CONTEXT.project,
      hostId: 'local',
      repoId: `repo-${label}`,
      path: `/w/${label}`,
      kind: 'git',
      selector: `id:repo-${label}::/w/${label}`
    },
    setupCount: 1,
    account: { verified: true, receipt: receipt(percent) },
    load: loadPerCore === null ? null : load(loadPerCore),
    ...change
  }
}

function order(candidates: LaunchCandidate[]): string[] {
  return rankLaunchCandidates(candidates, CONTEXT).ranked.map((entry) => entry.label)
}

describe('rankLaunchCandidates', () => {
  it('ranks by load band first: ok, then offload, then unknown', () => {
    expect(
      order([
        candidate('unknown', 99, null),
        candidate('offload', 99, 0.7),
        candidate('ok', 20, 0.1)
      ])
    ).toEqual(['ok', 'offload', 'unknown'])
  })

  it('then by 10-point headroom buckets, so a few points inside a bucket do not decide', () => {
    expect(order([candidate('b', 61, 0.1), candidate('a', 79, 0.1)])).toEqual(['a', 'b'])
    // 71 and 79 share a bucket, so the label decides.
    expect(order([candidate('b', 79, 0.1), candidate('a', 71, 0.1)])).toEqual(['a', 'b'])
  })

  it('then this computer, then paired before SSH, then the label', () => {
    const local = candidate('this computer', 72, 0.1, {
      route: { kind: 'local' },
      isThisComputer: true
    })
    const ssh = candidate('aaa', 75, 0.1, { route: { kind: 'ssh', targetId: 't', label: 'aaa' } })
    const paired = candidate('zzz', 70, 0.1)
    expect(order([ssh, paired, local])).toEqual(['this computer', 'zzz', 'aaa'])
    expect(order([candidate('m', 70, 0.1), candidate('b', 70, 0.1)])).toEqual(['b', 'm'])
  })

  it('says what decided the pick over the runner-up', () => {
    expect(
      rankLaunchCandidates([candidate('a', 80, 0.1), candidate('b', 80, 0.7)], CONTEXT).why
    ).toBe('lower load than b (ok vs offload)')
    expect(
      rankLaunchCandidates([candidate('a', 80, 0.1), candidate('b', 40, 0.1)], CONTEXT).why
    ).toBe('more fresh headroom than b (80% vs 40%)')
    expect(rankLaunchCandidates([candidate('a', 80, 0.1)], CONTEXT).why).toBe(
      'the only computer that can take it now (80% left, ok load)'
    )
  })

  it('excludes hot, old, no setup, no idempotent create and unverifiable computers', () => {
    const ranking = rankLaunchCandidates(
      [
        candidate('hot', 90, 0.91),
        candidate('old', 90, 0.1, { launchCapability: false, appVersion: '1.12.18' }),
        candidate('no-setup', 90, 0.1, { setup: null }),
        candidate('no-repo', 90, 0.1, {
          setup: { ...candidate('x', 1, null).setup!, repoId: '' }
        }),
        candidate('no-create', 90, 0.1, { idempotentCreate: false }),
        candidate('late', 90, 0.1, {
          state: 'unverifiable',
          reason: 'did not answer within 30 s (unverifiable)'
        }),
        candidate('silent', 90, 0.1, { reachable: false }),
        candidate('limited', 90, 0.1, {
          account: {
            verified: false,
            refusal: 'No claude account …',
            accounts: [{ label: 'a', state: 'limited', reason: 'limited', until: NOW + 3_600_000 }]
          }
        }),
        candidate('fine', 10, 0.5)
      ],
      CONTEXT
    )
    expect(ranking.chosen?.label).toBe('fine')
    expect(ranking.runnerUp).toBeNull()
    const states = Object.fromEntries(ranking.candidates.map((entry) => [entry.label, entry.state]))
    expect(states).toEqual({
      fine: 'fresh',
      hot: 'hot',
      old: 'old-runtime',
      'no-setup': 'no-setup',
      'no-repo': 'no-setup',
      'no-create': 'no-idempotent-create',
      late: 'unverifiable',
      silent: 'unverifiable',
      limited: 'unverified-account'
    })
    const reasons = Object.fromEntries(
      ranking.candidates.map((entry) => [entry.label, entry.reason])
    )
    expect(reasons.hot).toBe('0.91 load per core (hot)')
    expect(reasons.old).toContain('1.12.18')
    expect(reasons.old).toContain('agent-session.verified-account-launch.v1')
    expect(reasons.late).toBe('did not answer within 30 s (unverifiable)')
    expect(reasons.limited).toMatch(/^claude limited until \d\d:\d\d$/)
  })

  it('keeps the reader’s state and words for a computer it already judged', () => {
    const judged = candidate('mw0004', 90, 0.1, {
      state: 'no-setup',
      reason: 'no ready setup of github:omnirogue/omni-ide (omni project setup-clone …)'
    })
    expect(rankLaunchCandidates([judged], CONTEXT).candidates[0]).toMatchObject({
      state: 'no-setup',
      reason: 'no ready setup of github:omnirogue/omni-ide (omni project setup-clone …)'
    })
  })

  it('dedupes routes to one machine: most headroom wins, a tie goes to the paired runtime', () => {
    const paired = candidate('mw0002', 60, 0.1, { machineId: 'm1' })
    const ssh = candidate('mw0002 (ssh)', 64, 0.1, {
      machineId: 'm1',
      route: { kind: 'ssh', targetId: 't', label: 'mw0002 (ssh)' }
    })
    const better = rankLaunchCandidates([paired, ssh], CONTEXT)
    expect(better.ranked.map((entry) => entry.label)).toEqual(['mw0002 (ssh)'])
    expect(better.candidates.find((entry) => entry.label === 'mw0002')).toMatchObject({
      state: 'duplicate',
      reason: 'same computer as mw0002 (ssh), which has the better route'
    })
    const tie = rankLaunchCandidates([{ ...ssh, account: paired.account }, paired], CONTEXT)
    expect(tie.ranked.map((entry) => entry.label)).toEqual(['mw0002'])
  })

  it('excludes every route to a machine any route measured hot, even one whose own load is unknown', () => {
    const paired = candidate('mw0002', 90, null, { machineId: 'm1' })
    const ssh = candidate('mw0002 (ssh)', 90, 0.91, {
      machineId: 'm1',
      route: { kind: 'ssh', targetId: 't', label: 'mw0002 (ssh)' }
    })
    const ranking = rankLaunchCandidates([paired, ssh], CONTEXT)
    expect(ranking.chosen).toBeNull()
    expect(ranking.candidates.find((entry) => entry.label === 'mw0002')).toMatchObject({
      state: 'hot',
      reason: 'same computer as mw0002 (ssh), measured 0.91 load per core (hot)'
    })
    const elsewhere = candidate('laptop', 40, null)
    expect(rankLaunchCandidates([paired, ssh, elsewhere], CONTEXT).chosen?.label).toBe('laptop')
  })

  it('never merges routes without a machine id, so nothing is double-counted or lost', () => {
    const ranking = rankLaunchCandidates(
      [candidate('a', 60, 0.1, { machineId: null }), candidate('b', 60, 0.1, { machineId: null })],
      CONTEXT
    )
    expect(ranking.ranked.map((entry) => entry.label)).toEqual(['a', 'b'])
    expect(ranking.runnerUp?.label).toBe('b')
  })
})

describe('launchPlacementRefusal (R17)', () => {
  it('names every computer looked at and why, and never falls back to this computer', () => {
    const ranking = rankLaunchCandidates(
      [
        candidate('this computer', 0, 0.1, {
          route: { kind: 'local' },
          isThisComputer: true,
          account: {
            verified: false,
            refusal: 'No claude account …',
            accounts: [{ label: 'a', state: 'limited', reason: 'limited', until: NOW }]
          }
        }),
        candidate('Mac Studio', 90, 0.1, { launchCapability: false, appVersion: '1.12.18' }),
        candidate('mw0003', 90, 0.91)
      ],
      CONTEXT
    )
    expect(ranking.chosen).toBeNull()
    const text = launchPlacementRefusal({
      provider: 'claude',
      project: CONTEXT.project,
      candidates: ranking.candidates.map(launchCandidateSummary)
    })
    expect(text.split('\n')[0]).toBe(
      'No computer can take this claude launch for github:omnirogue/omni-ide now:'
    )
    expect(text).toMatch(/\n {2}this computer: claude limited until \d\d:\d\d\n/)
    expect(text).toContain('\n  Mac Studio: OmniConsole 1.12.18: launch needs OmniConsole update')
    expect(text).toContain('\n  mw0003: 0.91 load per core (hot)\n')
    expect(text.endsWith('\nNothing launched.')).toBe(true)
  })

  it('says a repo: project id keeps the search on this computer', () => {
    const text = launchPlacementRefusal({ provider: 'codex', project: 'repo:abc', candidates: [] })
    expect(text).toContain("repo:abc is this computer's own project id")
    expect(text).toContain('no computer could be looked at')
  })
})

describe('measured memory placement', () => {
  const memory = (free: number, loadPerCore = 0.1): AgentLaunchLoad => ({
    ...load(loadPerCore),
    freeBytes: free * 1024 ** 3,
    totalBytes: 64 * 1024 ** 3
  })

  it('prefers available RAM within one CPU band before account headroom', () => {
    const roomy = candidate('roomy', 20, 0.1, { load: memory(32) })
    const tight = candidate('tight', 99, 0.1, { load: memory(1) })
    const result = rankLaunchCandidates([tight, roomy], CONTEXT)
    expect(result.chosen?.label).toBe('roomy')
    expect(result.why).toContain('more available memory')
  })

  it('keeps CPU hot exclusion and existing CPU thresholds authoritative', () => {
    expect(
      order([
        candidate('hot', 99, 0.9, { load: memory(50, 0.9) }),
        candidate('offload', 99, 0.7, { load: memory(40, 0.7) }),
        candidate('ok', 20, 0.1, { load: memory(4) })
      ])
    ).toEqual(['ok', 'offload'])
  })

  it('keeps missing or invalid memory unknown and ranks exhausted measured RAM last', () => {
    expect(
      order([
        candidate('unknown', 70, 0.1),
        candidate('invalid', 70, 0.1, { load: { ...memory(2), freeBytes: Number.NaN } }),
        candidate('exhausted', 99, 0.1, { load: memory(0) }),
        candidate('measured', 20, 0.1, { load: memory(4) })
      ])
    ).toEqual(['measured', 'invalid', 'unknown', 'exhausted'])
  })
})
