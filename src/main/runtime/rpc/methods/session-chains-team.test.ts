import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_CHAIN_METHODS } from './session-chains'

const work = 'Ship the billing export with tests'
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

function dispatch(params: unknown) {
  const commit = vi.fn()
  const runtime = {
    getRuntimeId: () => 'runtime',
    hasSessionOutcomeContinuation: () => true,
    getSessionOutcomeService: () => ({ commit })
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_CHAIN_METHODS })
  return {
    commit,
    response: dispatcher.dispatch({
      id: 'req',
      authToken: 'tok',
      method: 'sessionChain.commitOutcomes',
      params
    })
  }
}

describe('commitOutcomes team wire field', () => {
  it('advertises team plans and accepts an optional team past parameter validation', async () => {
    const capabilities = new RpcDispatcher({
      runtime: {
        getRuntimeId: () => 'runtime',
        hasSessionOutcomeContinuation: () => true
      } as unknown as OrcaRuntimeService,
      methods: SESSION_CHAIN_METHODS
    })
    await expect(
      capabilities.dispatch({
        id: 'caps',
        authToken: 'tok',
        method: 'sessionChain.outcomeCapabilities'
      })
    ).resolves.toMatchObject({ ok: true, result: { teamPlans: 1 } })
    const { response } = dispatch({
      chain: { id: 'chain' },
      expectedRevision: 0,
      outcomes: [outcome],
      source: 'ai',
      team
    })
    // Without caller authority the handler refuses after parsing, which proves the field is on the wire.
    expect(JSON.stringify(await response)).toContain('Outcome mutations require')
  })

  it('rejects a malformed team before any handler runs', async () => {
    const overRounds = JSON.parse(JSON.stringify(team)) as {
      outcomes: { steps: Record<string, unknown>[] }[]
    }
    overRounds.outcomes[0]!.steps[1]!.maxRounds = 6
    const malformed: unknown[] = [overRounds, { outcomes: [] }, { ...team, extra: true }]
    for (const bad of malformed) {
      const { commit, response } = dispatch({
        chain: { id: 'chain' },
        expectedRevision: 0,
        outcomes: [outcome],
        source: 'ai',
        team: bad
      })
      const result = await response
      expect(result).toMatchObject({ ok: false })
      expect(JSON.stringify(result)).not.toContain('Outcome mutations require')
      expect(commit).not.toHaveBeenCalled()
    }
  })
})
