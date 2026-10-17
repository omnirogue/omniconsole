import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { normalizeSessionChainStep } from '../../shared/session-chain-step-normalize'
import type { SessionPrepRouterResult } from '../session-prep/session-prep-router-cli'
import type { DiscoverCommitMessageModelsResult } from '../text-generation/source-control-text-generation-types'
import { resolveSessionOutcomeDefaultModels } from './session-outcome-default-models'
import { routeSessionOutcomeDefaultModel } from './session-outcome-model-router'

const { verifiedModels } = vi.hoisted(() => ({ verifiedModels: vi.fn() }))
vi.mock('./session-outcome-routing-models', () => ({
  discoverSessionOutcomeRoutingModels: verifiedModels
}))

const model = (id: string) => ({
  id,
  label: id,
  thinkingLevels: ['low', 'medium', 'high'].map((id) => ({ id, label: id }))
})
const catalog: DiscoverCommitMessageModelsResult = {
  success: true,
  catalogOrigin: 'probe',
  models: [model('gpt-6-astra'), model('gpt-6-luna')],
  defaultModelId: 'gpt-6-astra',
  capability: {
    id: 'codex',
    label: 'Codex',
    modelSource: 'dynamic',
    models: [model('gpt-6-astra'), model('gpt-6-luna')],
    defaultModelId: 'gpt-6-astra'
  }
}
function setup(
  result: SessionPrepRouterResult = {
    provider: 'codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    tier: 'fast',
    reason: 'Bounded task',
    gate: 'rules',
    note: '',
    mode: 'live',
    modelEvidence: 'advertised',
    version: 'fixture',
    elapsedMs: 2
  }
) {
  const chain: SessionChain = {
    id: 'chain',
    workspacePath: '/worker/chosen',
    worktreeId: 'folder',
    hostId: 'ssh-worker',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [{ id: 'write', agent: 'codex', prompt: 'Write a short report', status: 'queued' }]
  }
  const input: SessionOutcomeCommit = {
    expectedRevision: 0,
    source: 'user',
    outcomes: [
      {
        id: 'report',
        title: 'Report',
        finish: 'my-review',
        dependsOn: [],
        stepIds: ['write'],
        conditions: [{ id: 'file', kind: 'file', target: '/worker/report.md' }],
        actions: [
          {
            id: 'finish',
            agent: 'codex',
            instruction: 'Finish the report',
            conditionIds: ['file'],
            authority: 'existing-user-authority'
          }
        ]
      }
    ]
  }
  const runtime = {
    discoverRuntimeCommitMessageModels: vi.fn().mockResolvedValue(catalog),
    routeSessionOutcomeModel: vi.fn().mockResolvedValue(result)
  }
  return { chain, input, runtime }
}
const step = (chain: SessionChain) => chain.steps[0] as SessionChainAgentStep

beforeEach(() => {
  verifiedModels.mockReset()
  verifiedModels.mockImplementation(async (_runtime, _chain, _agent, models) => ({ models }))
})
afterEach(() => vi.unstubAllEnvs())

describe('ordinary outcome routing through the existing classifier', () => {
  it('uses discovered host models for omitted models and persists the step decision', async () => {
    const value = setup()
    const before = structuredClone({ chain: value.chain, input: value.input })
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({
      model: 'gpt-6-luna',
      effort: 'medium',
      routing: {
        status: 'selected',
        modelEvidence: 'advertised',
        selected: { provider: 'codex', model: 'gpt-6-luna', effort: 'medium' }
      }
    })
    expect(result.input.outcomes[0]!.actions[0]).toMatchObject({
      model: 'gpt-6-luna',
      effort: 'medium'
    })
    expect(result.input.outcomes[0]!.actions[0]).not.toHaveProperty('routing')
    expect(value.runtime.discoverRuntimeCommitMessageModels).toHaveBeenCalledExactlyOnceWith(
      'id:folder',
      'codex'
    )
    expect(value.runtime.routeSessionOutcomeModel).toHaveBeenCalledTimes(2)
    expect(value.runtime.routeSessionOutcomeModel.mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      enabledProviders: ['codex'],
      executionTarget: { path: '/worker/chosen', hostId: 'ssh-worker' },
      catalog: { hostId: 'ssh-worker', agents: [{ provider: 'codex', discovered: true }] }
    })
    expect(normalizeSessionChainStep(step(result.chain))).toMatchObject({
      routing: step(result.chain).routing
    })
    expect({ chain: value.chain, input: value.input }).toEqual(before)
  })

  it('preserves explicit model, effort and account choices without calling the router', async () => {
    const value = setup()
    Object.assign(step(value.chain), {
      model: 'exact-model',
      effort: 'high',
      accountChoiceId: 'account'
    })
    Object.assign(value.input.outcomes[0]!.actions[0]!, { model: 'exact-action', effort: 'low' })
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({
      model: 'exact-model',
      effort: 'high',
      accountChoiceId: 'account'
    })
    expect(value.runtime.routeSessionOutcomeModel).not.toHaveBeenCalled()
    expect(value.runtime.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled()
  })

  it('keeps canonical producer, review and repair model assignments unchanged', async () => {
    const value = setup()
    value.input.outcomes[0]!.actions = []
    const review = {
      groupId: 'group',
      reviewerId: 'critic',
      round: 1,
      maxRounds: 2,
      candidateVersion: 'v1',
      adversarial: true
    }
    value.chain.steps.push(
      { id: 'review', agent: 'codex', prompt: 'Review', status: 'queued', review },
      {
        id: 'repair',
        agent: 'codex',
        prompt: 'Repair',
        status: 'queued',
        reviewRepair: {
          groupId: 'group',
          afterRound: 1,
          candidateVersion: 'v1',
          consumptionKey: 'repair'
        }
      }
    )
    value.input.outcomes[0]!.stepIds = ['write', 'review', 'repair']
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(result.chain.steps.map((s) => (s.kind === 'handoff' ? null : s.model))).toEqual([
      'gpt-6-astra',
      'gpt-6-astra',
      'gpt-6-astra'
    ])
    expect(value.runtime.routeSessionOutcomeModel).not.toHaveBeenCalled()
  })

  it.each(['off', 'shadow'] as const)('keeps host defaults in %s mode', async (mode) => {
    const value = setup({
      provider: 'codex',
      model: 'gpt-6-luna',
      effort: 'medium',
      tier: 'fast',
      reason: 'Recommendation',
      gate: 'rules',
      note: '',
      mode
    })
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({ model: 'gpt-6-astra', routing: { status: mode } })
    expect(step(result.chain).effort).toBeUndefined()
  })

  it('keeps an explicit effort when a mismatched recommendation is rejected', async () => {
    const value = setup()
    step(value.chain).effort = 'high'
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'high',
      routing: { status: 'unavailable' }
    })
    expect(value.runtime.routeSessionOutcomeModel.mock.calls[0]?.[0]).toMatchObject({
      effort: 'high'
    })
  })

  it('keeps the old host default on unavailable discovery and records the fallback', async () => {
    const value = setup({
      status: 'unavailable',
      unrouted: 'classifier deadline',
      blocking: false,
      mode: 'live'
    })
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({
      model: 'gpt-6-astra',
      routing: { status: 'unavailable', reason: 'classifier deadline' }
    })
  })

  it('uses only a workflow/account verified fallback when the host default is not offered', async () => {
    const value = setup({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      tier: 'standard',
      reason: 'Standard work',
      gate: 'rules',
      note: '',
      mode: 'live'
    })
    value.runtime.discoverRuntimeCommitMessageModels.mockResolvedValue({
      ...catalog,
      models: [model('gpt-6.1-sol'), ...catalog.models],
      defaultModelId: 'gpt-6.1-sol'
    })
    verifiedModels.mockResolvedValue({ models: [model('gpt-6-astra')] })
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({
      model: 'gpt-6-astra',
      routing: { status: 'unavailable' }
    })
    expect(
      value.runtime.routeSessionOutcomeModel.mock.calls[0]?.[0].catalog.agents[0].models
    ).toEqual([model('gpt-6-astra')])
  })

  it.each(['unavailable', 'invalid'] as const)(
    'never creates a Fable fallback after an %s recommendation',
    async (failure) => {
      const value = setup(
        failure === 'unavailable'
          ? { status: 'unavailable', unrouted: 'classifier unavailable', mode: 'live' }
          : {
              provider: 'claude',
              model: 'unsupported-model',
              effort: 'medium',
              tier: 'standard',
              reason: 'Unusable choice',
              gate: 'rules',
              note: '',
              mode: 'live'
            }
      )
      const actor = { agent: 'claude' as const, prompt: 'Prepare a report' }
      const result = await routeSessionOutcomeDefaultModel(value.runtime, value.chain, actor, [
        model('fable'),
        model('claude-fable-5-1'),
        model('opus')
      ])
      expect(result).toBe('opus')
      expect(actor).toMatchObject({ routing: { status: 'unavailable' } })
    }
  )

  it('does not create a router fallback when only Fable is verified', async () => {
    const value = setup({ status: 'unavailable', unrouted: 'classifier unavailable', mode: 'live' })
    const result = await routeSessionOutcomeDefaultModel(
      value.runtime,
      value.chain,
      { agent: 'claude', prompt: 'Prepare a report' },
      [model('fable')]
    )
    // Undefined returns control to the existing default path; it does not choose a new Fable model.
    expect(result).toBeUndefined()
  })

  it('preserves existing defaults visibly when exact account evidence is incomplete', async () => {
    const value = setup()
    verifiedModels.mockResolvedValue({
      models: [],
      unavailableReason: 'Account discovery incomplete'
    })
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({
      model: 'gpt-6-astra',
      routing: { status: 'unavailable', reason: 'Account discovery incomplete' }
    })
    expect(value.runtime.routeSessionOutcomeModel).not.toHaveBeenCalled()
  })

  it('skips account probes under host off and preserves host defaults under host shadow', async () => {
    const value = setup()
    const runtime = { ...value.runtime, getDispatchRoutingMode: vi.fn().mockReturnValue('off') }
    const off = await resolveSessionOutcomeDefaultModels(runtime, value.chain, value.input)
    expect(step(off.chain)).toMatchObject({ model: 'gpt-6-astra', routing: { status: 'off' } })
    expect(verifiedModels).not.toHaveBeenCalled()
    expect(runtime.routeSessionOutcomeModel).not.toHaveBeenCalled()
    runtime.getDispatchRoutingMode.mockReturnValue('shadow')
    const shadow = await resolveSessionOutcomeDefaultModels(runtime, value.chain, value.input)
    expect(step(shadow.chain)).toMatchObject({
      model: 'gpt-6-astra',
      routing: { status: 'shadow' }
    })
  })

  it('holds a blocked live choice and preserves the original input', async () => {
    const value = setup({
      status: 'unavailable',
      unrouted: 'No compatible model',
      blocking: true,
      mode: 'live'
    })
    const before = structuredClone({ chain: value.chain, input: value.input })
    await expect(
      resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    ).rejects.toThrow('No compatible model')
    expect({ chain: value.chain, input: value.input }).toEqual(before)
  })

  it('honors operator rollback even when a result says live', async () => {
    vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', 'off')
    const value = setup()
    const result = await resolveSessionOutcomeDefaultModels(value.runtime, value.chain, value.input)
    expect(step(result.chain)).toMatchObject({ model: 'gpt-6-astra', routing: { status: 'off' } })
  })
})
