import { describe, expect, it } from 'vitest'
import { chooseVerifiedLaunchAccount } from '../shared/account-launch-verdict'
import {
  LAUNCH_OLD_RUNTIME_NOTE,
  launchCapacityFromChoice,
  type LaunchPlacementRoute
} from '../shared/agent-launch-placement-types'
import type { LaunchCandidateQuery, LaunchCandidateReading } from './launch-candidate-reader'
import { classifyLaunchCandidate, type LaunchCandidateFacts } from './launch-candidate-state'
import { formatLaunchCapacity } from './launch-capacity-format'
import {
  NEW_RUNTIME_CAPABILITIES,
  NOW,
  OLD_RUNTIME_CAPABILITIES,
  OMNI_IDE,
  accountReceipt,
  capacityRow,
  launchLoad,
  projectSetup,
  readinessResult
} from './launch-capacity-test-fixtures'
import { launchCapacityView } from './launch-capacity-view'
import { quoteCliCommandArgument } from './shell-command-quote'

const LOCAL: LaunchPlacementRoute = { kind: 'local' }
const STUDIO: LaunchPlacementRoute = {
  kind: 'environment',
  environmentId: 'env-studio',
  name: 'Mac Studio'
}
const MW0002: LaunchPlacementRoute = {
  kind: 'environment',
  environmentId: 'env-2586',
  name: 'mw0002'
}
const MW0002_SSH: LaunchPlacementRoute = { kind: 'ssh', targetId: 'ssh-2586', label: 'mw0002' }
const NAMES = {
  environments: [
    { id: 'env-studio', name: 'Mac Studio' },
    { id: 'env-2586', name: 'mw0002' }
  ],
  sshTargets: [{ id: 'ssh-2586', label: 'mw0002' }]
}

function query(change: Partial<LaunchCandidateQuery> = {}): LaunchCandidateQuery {
  return { provider: 'claude', model: null, project: null, readOldRuntimeAccounts: true, ...change }
}

function routeLabel(route: LaunchPlacementRoute): string {
  return route.kind === 'local'
    ? 'this computer'
    : route.kind === 'environment'
      ? route.name
      : route.label
}

/** Readiness resolves an SSH route's setup to that target, and every other route's to local. */
function routeWorkspace(route: LaunchPlacementRoute) {
  return {
    ...readinessResult().workspace,
    hostId: route.kind === 'ssh' ? (`ssh:${route.targetId}` as const) : ('local' as const)
  }
}

function reading(
  route: LaunchPlacementRoute,
  change: Partial<LaunchCandidateFacts> = {},
  listedAccounts: LaunchCandidateReading['listedAccounts'] = null
): LaunchCandidateReading {
  const facts: LaunchCandidateFacts = {
    route,
    label: routeLabel(route),
    isThisComputer: route.kind === 'local',
    checkedAt: NOW,
    provider: 'claude',
    project: null,
    status: {
      ok: true,
      // Why 'rt-1': readinessResult answers for runtime rt-1, and readiness must match it.
      runtimeId: 'rt-1',
      appVersion: '1.13.0',
      capabilities: NEW_RUNTIME_CAPABILITIES,
      sessionHostId: null
    },
    setups: {
      ok: true,
      setups: [projectSetup({ hostId: route.kind === 'ssh' ? `ssh:${route.targetId}` : 'local' })]
    },
    readiness: { ok: true, result: readinessResult({ workspace: routeWorkspace(route) }) },
    ...change
  }
  return { candidate: classifyLaunchCandidate(facts), listedAccounts }
}

function verified(remainingPercent: number, change: Parameters<typeof readinessResult>[0] = {}) {
  return {
    ok: true as const,
    result: readinessResult({
      account: { verified: true, receipt: accountReceipt({ remainingPercent }) },
      ...change
    })
  }
}

function oldStudio(): LaunchCandidateReading {
  const choice = chooseVerifiedLaunchAccount([capacityRow()], { provider: 'claude', now: NOW })
  return reading(
    STUDIO,
    {
      status: {
        ok: true,
        runtimeId: 'rt-studio',
        appVersion: '1.12.18',
        capabilities: OLD_RUNTIME_CAPABILITIES,
        sessionHostId: null
      },
      readiness: null
    },
    launchCapacityFromChoice(choice, NOW)
  )
}

function view(readings: LaunchCandidateReading[], change: Partial<LaunchCandidateQuery> = {}) {
  return launchCapacityView({ query: query(change), readings, names: NAMES, checkedAt: NOW })
}

describe('omni host list --capacity view', () => {
  it("shows an older runtime's headroom read-only and never offers a launch there", () => {
    const result = view([reading(LOCAL), oldStudio()])
    const studio = result.rows.find((row) => row.label === 'Mac Studio')!

    expect(studio).toMatchObject({
      eligible: false,
      launchCapability: false,
      appVersion: '1.12.18',
      accounts: {
        claude: {
          freshness: 'fresh',
          bestRemainingPercent: 64,
          boundBy: 'weekly',
          readingAgeMs: 20_000,
          source: 'accounts-list'
        }
      }
    })
    expect(studio.reason).toBe(`OmniConsole 1.12.18: ${LAUNCH_OLD_RUNTIME_NOTE}`)
    expect(studio.recommendedCommand).toBeUndefined()
    expect(result.notes).toContain(
      `Read-only until updated (${LAUNCH_OLD_RUNTIME_NOTE}): Mac Studio.`
    )
    expect(formatLaunchCapacity(result)).toContain(
      '64% left · weekly · 20 s old · 1/1 verified (read-only)'
    )
  })

  it('reads an unreachable computer as unverifiable, never idle or 0%', () => {
    const reason = 'did not answer within 8 s (unverifiable)'
    const result = view([
      reading(LOCAL),
      reading(MW0002, {
        status: { ok: false, reason },
        setups: { ok: false, unsupported: false, reason },
        readiness: null
      })
    ])
    const row = result.rows.find((entry) => entry.label === 'mw0002')!

    expect(row).toMatchObject({ reachable: false, eligible: false, load: null, reason })
    expect(row.accounts.claude).toMatchObject({
      freshness: 'unverifiable',
      bestRemainingPercent: null
    })
    const line = formatLaunchCapacity(result)
      .split('\n')
      .find((text) => text.startsWith('mw0002'))!
    expect(line).toMatch(/unverifiable\s+unknown\s+no\s+did not answer/)
  })

  it('merges routes to one machine by machine id; the launchable route with most headroom leads', () => {
    const result = view([
      reading(LOCAL, { readiness: verified(40, { machineId: 'mach-local' }) }),
      reading(MW0002, { readiness: verified(60, { machineId: 'mach-2586' }) }),
      reading(MW0002_SSH, {
        readiness: verified(75, {
          machineId: 'mach-2586',
          workspace: { ...readinessResult().workspace, hostId: 'ssh:ssh-2586' }
        })
      })
    ])

    expect(result.rows).toHaveLength(2)
    const machine = result.rows[0]!
    expect(machine).toMatchObject({ label: 'mw0002', machineId: 'mach-2586', eligible: true })
    expect(machine.routes.map(({ route }) => route.kind)).toEqual(['environment', 'ssh'])
    expect(machine.accounts.claude?.bestRemainingPercent).toBe(75)
    expect(machine.reason).toContain('also reached as mw0002 (paired)')
    // Why explicit: the name is both a paired computer and an SSH target; the read went over SSH.
    expect(machine.recommendedCommand).toBe(
      'omni session launch --provider claude --host ssh:ssh-2586 --worktree <selector> --prompt-file <brief.md> --json'
    )
  })

  it('keeps routes without a machine id apart and says so', () => {
    const result = view([reading(LOCAL), reading(MW0002), reading(MW0002_SSH)])

    expect(result.rows).toHaveLength(3)
    expect(result.rows.every((row) => row.machineId === null)).toBe(true)
    expect(result.notes).toContain(
      'Not merged without a machine id, so each route has its own row: mw0002.'
    )
  })

  it('excludes a hot computer by name', () => {
    const result = view([
      reading(LOCAL),
      reading(MW0002, { readiness: verified(95, { load: launchLoad(0.91) }) })
    ])
    const hot = result.rows.find((row) => row.label === 'mw0002')!

    expect(hot).toMatchObject({ eligible: false, reason: '0.91 load per core (hot)' })
    expect(hot.load?.band).toBe('hot')
    expect(result.rows[0]!.label).toBe('this computer')
    expect(formatLaunchCapacity(result)).toMatch(/mw0002\s+paired\s+95% left.*hot 0\.91\s+no/)
  })

  it('without --project, recommends the best computer by name and offers --project', () => {
    const result = view([
      reading(LOCAL, { readiness: verified(52) }),
      reading(STUDIO, { readiness: verified(90) })
    ])

    expect(result.rows.map((row) => row.label)).toEqual(['Mac Studio', 'this computer'])
    expect(result.rows.every((row) => row.project === null)).toBe(true)
    expect(result.recommendedCommand).toBe(
      `omni session launch --provider claude --host ${quoteCliCommandArgument('Mac Studio')} --worktree <selector> --prompt-file <brief.md> --json`
    )
    expect(result.rows[1]!.recommendedCommand).toBe(
      'omni session launch --provider claude --host local --prompt-file <brief.md> --json'
    )
    expect(result.notes).toContain(
      'Or pass --project <id> and the command picks the computer and the account.'
    )
    const text = formatLaunchCapacity(result)
    expect(text).not.toContain('PROJECT')
    expect(text).toContain(`Launch: ${result.recommendedCommand}`)
  })

  it('with --project, counts setups and recommends the command that picks the computer', () => {
    const project = OMNI_IDE
    const result = view(
      [
        reading(LOCAL, {
          project,
          setups: {
            ok: true,
            setups: [projectSetup(), projectSetup({ id: 'setup-2', path: '/w/omni-ide-2' })]
          }
        }),
        reading(STUDIO, { project, setups: { ok: true, setups: [] }, readiness: null })
      ],
      { project, model: 'claude-opus-4-1' }
    )
    const local = result.rows.find((row) => row.isThisComputer)!

    expect(local.project).toEqual({ identityKey: project.identityKey, present: true, setups: 2 })
    expect(local.recommendedCommand).toBe(
      'omni session launch --provider claude --project github:omnirogue/omni-ide --host local --model claude-opus-4-1 --prompt-file <brief.md> --json'
    )
    expect(result.rows.find((row) => row.label === 'Mac Studio')).toMatchObject({
      eligible: false,
      project: { present: false, setups: 0 }
    })
    expect(result.recommendedCommand).toBe(
      'omni session launch --provider claude --project github:omnirogue/omni-ide --model claude-opus-4-1 --prompt-file <brief.md> --json'
    )
    expect(formatLaunchCapacity(result)).toMatch(/PROJECT[\s\S]*2 setups\s+yes/)
  })

  it('names no command when no computer fits, and never prints a credential path', () => {
    const result = view(
      [reading(LOCAL, { readiness: verified(80, { load: launchLoad(0.95) }) }), oldStudio()],
      {
        project: OMNI_IDE
      }
    )

    expect(result.recommendedCommand).toBeNull()
    expect(result.notes).toContain(
      'No computer can take this claude launch for github:omnirogue/omni-ide now. Nothing to launch.'
    )
    const json = JSON.stringify(result)
    expect(JSON.parse(json)).toEqual(result)
    expect(json).not.toContain('.claude-a')
    expect(formatLaunchCapacity(result)).not.toContain('Launch:')
  })
})
