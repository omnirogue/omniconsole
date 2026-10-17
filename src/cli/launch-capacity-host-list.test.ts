import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchReadinessParams
} from '../shared/agent-launch-account'
import { LAUNCH_OLD_RUNTIME_NOTE } from '../shared/agent-launch-placement-types'
import type { LaunchCandidateReaderDeps } from './launch-candidate-reader'
import { readHostListCapacity } from './launch-capacity-host-list'
import {
  NEW_RUNTIME_CAPABILITIES,
  NOW,
  OLD_RUNTIME_CAPABILITIES,
  capacityRow,
  fakeRuntime,
  projectSetup,
  readinessResult,
  rpcError
} from './launch-capacity-test-fixtures'

const flags = (entries: [string, string | boolean][]) =>
  new Map<string, string | boolean>([['capacity', true], ...entries])

const unused = (): LaunchCandidateReaderDeps => {
  throw new Error('flags are refused before anything is read')
}

describe('readHostListCapacity', () => {
  it('refuses unusable flags before reading anything', async () => {
    await expect(readHostListCapacity(flags([]), unused)).rejects.toThrow(
      '--capacity needs --provider claude or --provider codex'
    )
    await expect(readHostListCapacity(flags([['provider', 'gemini']]), unused)).rejects.toThrow(
      '--capacity needs --provider'
    )
    await expect(
      readHostListCapacity(new Map<string, string | boolean>([['capacity', 'claude']]), unused)
    ).rejects.toThrow('--capacity takes no value')
    await expect(
      readHostListCapacity(
        flags([
          ['provider', 'claude'],
          ['environment', 'Mac Studio']
        ]),
        unused
      )
    ).rejects.toThrow('drop --environment')
  })

  it("answers today's fleet: this computer launchable, a 1.12.18 Mac read-only, a silent one unverifiable", async () => {
    const sent: AgentLaunchReadinessParams[] = []
    const local = fakeRuntime({
      'project.list': {
        projects: [{ id: 'github:omnirogue/omni-ide', displayName: 'omni-ide' }]
      },
      'status.get': {
        runtimeId: 'rt-local',
        appVersion: '1.13.0',
        capabilities: NEW_RUNTIME_CAPABILITIES
      },
      'projectHostSetup.list': { setups: [projectSetup()] },
      [AGENT_LAUNCH_READINESS_METHOD]: (params: AgentLaunchReadinessParams) => {
        sent.push(params)
        return readinessResult({ runtimeId: 'rt-local', machineId: 'mach-local' })
      }
    })
    const studio = fakeRuntime({
      'status.get': {
        runtimeId: 'rt-studio',
        appVersion: '1.12.18',
        capabilities: OLD_RUNTIME_CAPABILITIES
      },
      'projectHostSetup.list': { setups: [projectSetup({ id: 'studio-setup' })] },
      'accounts.list': {
        rateLimits: { accountCapacity: { claude: [capacityRow()], codex: [], builtAt: NOW } }
      }
    })
    const silent = fakeRuntime({
      'status.get': rpcError('runtime_timeout'),
      'projectHostSetup.list': rpcError('runtime_timeout')
    })
    const runtimes: Record<string, typeof local> = { 'env-studio': studio, 'env-2601': silent }

    const result = await readHostListCapacity(
      flags([
        ['provider', 'claude'],
        ['project', 'omni-ide']
      ]),
      () => ({
        now: () => NOW,
        local,
        environment: (id) => runtimes[id]!,
        environments: [
          { id: 'env-studio', name: 'Mac Studio' },
          { id: 'env-2601', name: 'mw0003' }
        ],
        listSshTargets: async () => []
      })
    )

    expect(sent).toHaveLength(1)
    expect(result.project).toEqual({
      input: 'omni-ide',
      identityKey: 'github:omnirogue/omni-ide',
      name: 'omni-ide'
    })
    expect(
      result.rows.map((row) => [
        row.label,
        row.eligible,
        row.accounts.claude?.freshness,
        row.project?.setups
      ])
    ).toEqual([
      ['this computer', true, 'fresh', 1],
      ['Mac Studio', false, 'fresh', 1],
      ['mw0003', false, 'unverifiable', 0]
    ])
    expect(result.rows[1]!.reason).toContain(LAUNCH_OLD_RUNTIME_NOTE)
    expect(result.recommendedCommand).toBe(
      'omni session launch --provider claude --project github:omnirogue/omni-ide --prompt-file <brief.md> --json'
    )
  })
})
