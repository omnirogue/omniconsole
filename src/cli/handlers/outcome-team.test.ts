import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { OUTCOME_HANDLERS } from './outcome'
import type { SessionChain } from '../../shared/session-chain-types'
import { prependNextOutcomeTeamPlan } from '../../shared/next-outcome-team-plan-instructions'

const work = 'Ship the billing export with tests'
const consentedAt = '2026-09-15T18:00:00.000Z'
const prompt = prependNextOutcomeTeamPlan(`${work}.`, 'omni', consentedAt)
const chain: SessionChain = {
  id: 'chain',
  sourcePaneKey: 'pane',
  sourceRowKey: 'row',
  worktreeId: 'repo::/work',
  workspacePath: '/work',
  hostId: 'local',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
}
const outcome = {
  id: 'ship',
  title: 'Ship billing export',
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: '/work/out.md' }],
  actions: []
}
const team = {
  outcomes: [
    {
      outcomeId: 'ship',
      steps: [
        { kind: 'agent', id: 'build', agent: 'codex', model: 'gpt-5.6-terra', instruction: work },
        {
          kind: 'review',
          id: 'review',
          reviewers: [{ agent: 'claude', model: 'opus' }],
          maxRounds: 2,
          instruction: work
        }
      ]
    }
  ]
}
let directory: string

function setup(capabilities: Record<string, unknown> = { teamPlans: 1 }, sourcePrompt = prompt) {
  const call = vi.fn(async (method: string, params?: unknown) => {
    const result = (value: unknown) => ({ id: 'rpc', ok: true, result: value })
    switch (method) {
      case 'sessionChain.outcomeCapabilities':
        return result({ version: 1, durableContinuation: true, ...capabilities })
      case 'sessionChain.outcomeSource':
        return result({ chain, prompt: sourcePrompt, expectedRevision: 0 })
      case 'preflight.detectAgents':
        return result(['codex', 'claude', 'not-an-agent'])
      case 'git.discoverCommitMessageModels':
        return (params as { agentId: string }).agentId === 'codex'
          ? result({
              success: true,
              catalogOrigin: 'probe',
              models: [
                {
                  id: 'gpt-5.6-terra',
                  label: 'Terra',
                  thinkingLevels: [{ id: 'high', label: 'High' }]
                }
              ]
            })
          : result({
              success: true,
              catalogOrigin: 'spec',
              models: [{ id: 'opus', label: 'Opus' }]
            })
      case 'sessionChain.commitOutcomes':
        return result({ chain })
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const context = {
    client: { call },
    flags: new Map(),
    cwd: directory,
    json: true
  } as unknown as HandlerContext
  return { call, context }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'outcome-team-cli-'))
  vi.stubEnv('ORCA_PANE_KEY', 'pane')
  vi.stubEnv('ORCA_WORKTREE_ID', 'repo::/work')
  vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'claim')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('team planning through the outcome CLI', () => {
  it('lists only probed usable agents with exact models and the planning instructions under consent', async () => {
    const { call, context } = setup()
    await OUTCOME_HANDLERS['outcome context'](context)
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0])
    expect(output.result.teamPlanning).toMatchObject({
      consentedAt,
      limits: { maxAgents: 8, maxReviewers: 5, maxRounds: 5 },
      usableAgents: [
        { agent: 'codex', models: [{ id: 'gpt-5.6-terra', label: 'Terra', efforts: ['high'] }] }
      ]
    })
    expect(output.result.instructions).toContain('Team plan:')
    expect(call).toHaveBeenCalledWith('git.discoverCommitMessageModels', {
      worktree: 'id:repo::/work',
      agentId: 'codex'
    })
  })

  it('keeps ordinary context free of team planning and probes', async () => {
    const { call, context } = setup({ teamPlans: 1 }, `${work}.`)
    await OUTCOME_HANDLERS['outcome context'](context)
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0])
    expect(output.result.teamPlanning).toBeUndefined()
    expect(output.result.instructions).toContain('do not authorize fan-out')
    expect(call.mock.calls.some(([method]) => method === 'preflight.detectAgents')).toBe(false)
  })

  it('sends a structurally valid team and refuses it on a host without team plans', async () => {
    const body = join(directory, 'plan.json')
    writeFileSync(
      body,
      JSON.stringify({ expectedRevision: 0, sourcePrompt: prompt, outcomes: [outcome], team })
    )
    const { call, context } = setup()
    context.flags.set('body-file', body)
    await OUTCOME_HANDLERS['outcome commit'](context)
    expect(call).toHaveBeenLastCalledWith(
      'sessionChain.commitOutcomes',
      expect.objectContaining({ team, source: 'ai' }),
      expect.anything()
    )
    const old = setup({})
    old.context.flags.set('body-file', body)
    await expect(OUTCOME_HANDLERS['outcome commit'](old.context)).rejects.toThrow(
      'cannot commit an agent-planned team'
    )
    expect(old.call.mock.calls.some(([method]) => method === 'sessionChain.commitOutcomes')).toBe(
      false
    )
  })

  it('rejects an over-limit or malformed team before contacting commit', async () => {
    const body = join(directory, 'bad.json')
    const sameModel = JSON.parse(JSON.stringify(team)) as {
      outcomes: { steps: Record<string, unknown>[] }[]
    }
    sameModel.outcomes[0]!.steps[1]!.reviewers = [{ agent: 'codex', model: 'gpt-5.6-terra' }]
    writeFileSync(
      body,
      JSON.stringify({
        expectedRevision: 0,
        sourcePrompt: prompt,
        outcomes: [outcome],
        team: sameModel
      })
    )
    const { call, context } = setup()
    context.flags.set('body-file', body)
    await expect(OUTCOME_HANDLERS['outcome commit'](context)).rejects.toThrow('same model')
    writeFileSync(
      body,
      JSON.stringify({
        expectedRevision: 0,
        sourcePrompt: prompt,
        outcomes: [outcome],
        team: { outcomes: [{ outcomeId: 'ship', steps: [], extra: true }] }
      })
    )
    await expect(OUTCOME_HANDLERS['outcome commit'](context)).rejects.toThrow()
    expect(call.mock.calls.some(([method]) => method === 'sessionChain.commitOutcomes')).toBe(false)
  })
})
