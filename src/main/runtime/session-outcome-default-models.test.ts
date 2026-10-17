import { describe, expect, it, vi } from 'vitest'
import type { CommitMessageModelCapability } from '../../shared/commit-message-agent-spec'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import type { DiscoverCommitMessageModelsResult } from '../text-generation/source-control-text-generation-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { resolveSessionOutcomeDefaultModels } from './session-outcome-default-models'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'

type Probe = OrcaRuntimeService['discoverRuntimeCommitMessageModels']

function model(id: string, efforts?: string[]): CommitMessageModelCapability {
  return {
    id,
    label: id,
    ...(efforts
      ? {
          thinkingLevels: efforts.map((effort) => ({ id: effort, label: effort })),
          defaultThinkingLevel: efforts[0]
        }
      : {})
  }
}

function discovered(
  models = [model('host-default'), model('review-a'), model('review-b')],
  defaultModelId = models[0]!.id
): Extract<DiscoverCommitMessageModelsResult, { success: true }> {
  return {
    success: true,
    catalogOrigin: 'probe',
    models,
    defaultModelId,
    capability: {
      id: 'codex',
      label: 'Codex',
      modelSource: 'dynamic',
      models,
      defaultModelId
    }
  }
}

function runtime(result: DiscoverCommitMessageModelsResult = discovered()) {
  return { discoverRuntimeCommitMessageModels: vi.fn<Probe>().mockResolvedValue(result) }
}

function actor(id: string, changes: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep {
  return { id, agent: 'codex', prompt: `Complete ${id}.`, status: 'queued', ...changes }
}

function reviewer(id: string, round: number, changes: Partial<SessionChainAgentStep> = {}) {
  return actor(`${id}-${round}`, {
    review: {
      groupId: 'review-group',
      reviewerId: id,
      round,
      maxRounds: 2,
      candidateVersion: `candidate-${round}`,
      adversarial: true
    },
    ...changes
  })
}

function plan(steps: SessionChain['steps'] = [actor('producer')]) {
  const chain: SessionChain = {
    id: 'chain',
    workspacePath: '/remote/chosen-folder',
    worktreeId: 'remote-folder-id',
    hostId: 'ssh-worker',
    sourcePaneKey: 'source',
    sourceRowKey: 'source-row',
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
  const input: SessionOutcomeCommit = {
    expectedRevision: 0,
    source: 'user',
    outcomes: [
      {
        id: 'deliver',
        title: 'Deliver the reviewed report',
        finish: 'my-review',
        dependsOn: [],
        stepIds: steps.map((step) => step.id),
        conditions: [{ id: 'file', kind: 'file', target: '/remote/report.md' }],
        actions: []
      }
    ]
  }
  return { chain, input }
}

function action(
  changes: Partial<SessionOutcomeCommit['outcomes'][number]['actions'][number]> = {}
) {
  return {
    id: 'write-report',
    instruction: 'Write the final report.',
    conditionIds: ['file'],
    authority: 'existing-user-authority' as const,
    agent: 'codex' as const,
    ...changes
  }
}

function stepModels(chain: SessionChain) {
  return chain.steps.map((step) => (step.kind === 'handoff' ? undefined : step.model))
}

function previousProducer(): SessionChain {
  const { chain, input } = plan([actor('producer', { model: 'gpt-5.6-terra' })])
  const { workflow } = workflowProofFixture()
  workflow.stages[0]!.outcomeIds = ['deliver']
  workflow.stages[0]!.stepIds = ['producer']
  chain.outcomeSet = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: 1,
    removals: [],
    attempts: [],
    continuation: { owner: 'execution-host', hostId: 'ssh-worker', epoch: 'epoch', state: 'owned' },
    outcomes: input.outcomes.map((outcome) => ({
      ...outcome,
      revision: 1,
      status: 'satisfied',
      evidence: []
    })),
    workflow
  }
  return chain
}

describe('session outcome execution-host model defaults', () => {
  it.each(['codex', 'claude', 'grok'] as const)(
    'pins omitted %s step and action models from the selected host once',
    async (agent) => {
      const value = plan([actor('producer', { agent })])
      value.input.outcomes[0]!.actions = [action({ agent })]
      const before = structuredClone(value)
      const catalog = discovered([model('alternative'), model('host-default')], 'host-default')
      catalog.capability.id = agent
      catalog.capability.label = agent
      const host = runtime(catalog)

      const result = await resolveSessionOutcomeDefaultModels(host, value.chain, value.input)

      expect(stepModels(result.chain)).toEqual(['host-default'])
      expect(result.input.outcomes[0]!.actions[0]!.model).toBe('host-default')
      expect(host.discoverRuntimeCommitMessageModels).toHaveBeenCalledExactlyOnceWith(
        'id:remote-folder-id',
        agent
      )
      expect(value).toEqual(before)
    }
  )

  it('prefers the CLI-advertised default over a stale catalog default', async () => {
    const { chain, input } = plan()
    const host = runtime(
      discovered([model('catalog-default'), { ...model('cli-default'), isDefault: true }])
    )
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)
    expect(stepModels(result.chain)).toEqual(['cli-default'])
  })

  it('preserves explicit step and action choices without probing', async () => {
    const { chain, input } = plan([
      actor('producer', { model: 'chosen-builder', effort: 'high' }),
      reviewer('reviewer', 1, { model: 'chosen-reviewer', effort: 'low' }),
      reviewer('reviewer', 2, { model: 'chosen-reviewer', effort: 'low' })
    ])
    input.outcomes[0]!.actions = [action({ model: 'chosen-action', effort: 'medium' })]
    const host = runtime({ success: false, error: 'Discovery must not be required.' })
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)

    expect(result).toEqual({ chain, input })
    expect(host.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled()
  })

  it('pins each reviewer and producer through repair rounds while allowing a shared default model', async () => {
    const { chain, input } = plan([
      actor('producer'),
      reviewer('first', 1),
      reviewer('second', 1),
      actor('repair', {
        reviewRepair: {
          groupId: 'review-group',
          afterRound: 1,
          candidateVersion: 'candidate-1',
          consumptionKey: 'repair-round-1'
        }
      }),
      reviewer('first', 2),
      reviewer('second', 2)
    ])
    const host = runtime()
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)

    expect(stepModels(result.chain)).toEqual([
      'host-default',
      'host-default',
      'host-default',
      'host-default',
      'host-default',
      'host-default'
    ])
    expect(host.discoverRuntimeCommitMessageModels).toHaveBeenCalledTimes(1)
  })

  it('preserves explicit choices while assigning omitted reviewers the host default', async () => {
    const { chain, input } = plan([
      actor('producer', { model: 'host-default' }),
      reviewer('automatic', 1),
      reviewer('chosen', 1, { model: 'review-a' }),
      reviewer('automatic', 2),
      reviewer('chosen', 2)
    ])
    const result = await resolveSessionOutcomeDefaultModels(runtime(), chain, input)
    expect(stepModels(result.chain)).toEqual([
      'host-default',
      'host-default',
      'review-a',
      'host-default',
      'review-a'
    ])
  })

  it('inherits an explicit reviewer model from a later round without discovery', async () => {
    const { chain, input } = plan([
      actor('producer', { model: 'chosen-builder' }),
      reviewer('reviewer', 1),
      reviewer('reviewer', 2, { model: 'chosen-reviewer' })
    ])
    const host = runtime()
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)
    expect(stepModels(result.chain)).toEqual([
      'chosen-builder',
      'chosen-reviewer',
      'chosen-reviewer'
    ])
    expect(host.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled()
  })

  it('rejects incompatible explicit reviewer models across rounds without changing the plan', async () => {
    const value = plan([
      actor('producer', { model: 'chosen-builder' }),
      reviewer('reviewer', 1, { model: 'first-choice' }),
      reviewer('reviewer', 2, { model: 'different-choice' })
    ])
    value.input.outcomes[0]!.actions = [action()]
    const before = structuredClone(value)
    await expect(
      resolveSessionOutcomeDefaultModels(runtime(), value.chain, value.input)
    ).rejects.toThrow(/same.*model|model.*round/i)
    expect(value).toEqual(before)
  })

  it('selects a compatible reviewer model independently from the producer default', async () => {
    const { chain, input } = plan([
      actor('producer'),
      reviewer('reviewer', 1, { effort: 'high' }),
      reviewer('reviewer', 2, { effort: 'high' })
    ])
    const host = runtime(
      discovered([model('gpt-5.6-terra', ['low']), model('gpt-6-astra', ['high'])])
    )
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)

    expect(stepModels(result.chain)).toEqual(['gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-astra'])
    expect(result.chain.steps[1]).toMatchObject({ effort: 'high' })
    expect(result.chain.steps[2]).toMatchObject({ effort: 'high' })
  })

  it('requires a reviewer model that supports the efforts of all its rounds', async () => {
    const { chain, input } = plan([
      actor('producer', { model: 'chosen-builder' }),
      reviewer('reviewer', 1, { effort: 'low' }),
      reviewer('reviewer', 2, { effort: 'high' })
    ])
    const host = runtime(
      discovered([model('gpt-5.6-terra', ['low']), model('gpt-6-astra', ['low', 'high'])])
    )
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)
    expect(stepModels(result.chain)).toEqual(['chosen-builder', 'gpt-6-astra', 'gpt-6-astra'])
  })

  it('rejects an unavailable effort combination without changing the caller plan', async () => {
    const value = plan([
      reviewer('reviewer', 1, { effort: 'low' }),
      reviewer('reviewer', 2, { effort: 'high' })
    ])
    const before = structuredClone(value)
    const host = runtime(
      discovered([model('gpt-5.6-terra', ['low']), model('gpt-6-astra', ['high'])])
    )

    await expect(resolveSessionOutcomeDefaultModels(host, value.chain, value.input)).rejects.toThrow(
      /compatible|effort|model/i
    )
    expect(value).toEqual(before)
  })

  it('selects a producer model that also supports its authorized repair effort', async () => {
    const { chain, input } = plan([
      actor('producer'),
      reviewer('reviewer', 1, { model: 'chosen-reviewer' }),
      actor('repair', {
        effort: 'high',
        reviewRepair: {
          groupId: 'review-group',
          afterRound: 1,
          candidateVersion: 'candidate-1',
          consumptionKey: 'repair-round-1'
        }
      })
    ])
    const host = runtime(
      discovered([model('gpt-5.6-terra', ['low']), model('gpt-6-astra', ['high'])])
    )
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)

    expect(stepModels(result.chain)).toEqual(['gpt-6-astra', 'chosen-reviewer', 'gpt-6-astra'])
    expect(result.chain.steps[2]).toMatchObject({ effort: 'high' })
  })

  it('allows the host default for added reviewers even when the accepted producer used it', async () => {
    const { chain, input } = plan([
      reviewer('reviewer', 1, { replacedStepId: 'producer' }),
      reviewer('reviewer', 2)
    ])
    const previous = previousProducer()
    const before = structuredClone(previous)
    const host = runtime(discovered([model('gpt-5.6-terra'), model('gpt-6-astra')]))
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input, previous)

    expect(stepModels(result.chain)).toEqual(['gpt-5.6-terra', 'gpt-5.6-terra'])
    expect(previous).toEqual(before)
  })

  it('retains an accepted source model for repairs when the draft starts with its reviewers', async () => {
    const { chain, input } = plan([
      reviewer('reviewer', 1, { replacedStepId: 'producer' }),
      actor('repair', {
        reviewRepair: {
          groupId: 'review-group',
          afterRound: 1,
          candidateVersion: 'candidate-1',
          consumptionKey: 'repair-round-1'
        }
      })
    ])
    const host = runtime(discovered([model('gpt-6-astra'), model('gpt-5.6-terra')]))
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input, previousProducer())

    expect(stepModels(result.chain)).toEqual(['gpt-6-astra', 'gpt-5.6-terra'])
  })

  it('keeps provider identity when the same model ID is advertised by separate agents', async () => {
    const { chain, input } = plan([
      actor('producer'),
      reviewer('reviewer', 1, { agent: 'claude' })
    ])
    const host = runtime(discovered([model('host-default')]))
    const result = await resolveSessionOutcomeDefaultModels(host, chain, input)

    expect(stepModels(result.chain)).toEqual(['host-default', 'host-default'])
    expect(host.discoverRuntimeCommitMessageModels).toHaveBeenCalledWith(
      'id:remote-folder-id',
      'codex'
    )
    expect(host.discoverRuntimeCommitMessageModels).toHaveBeenCalledWith(
      'id:remote-folder-id',
      'claude'
    )
  })

  it('supports four independent reviewers when the host offers only one model', async () => {
    const value = plan([
      actor('producer'),
      ...Array.from({ length: 4 }, (_, index) => reviewer(`reviewer-${index}`, 1))
    ])
    const before = structuredClone(value)
    const host = runtime(discovered([model('only-one')]))
    const result = await resolveSessionOutcomeDefaultModels(host, value.chain, value.input)

    expect(stepModels(result.chain)).toEqual([
      'only-one',
      'only-one',
      'only-one',
      'only-one',
      'only-one'
    ])
    expect(
      result.chain.steps
        .slice(1)
        .map((step) => (step.kind === 'handoff' ? undefined : step.review?.reviewerId))
    ).toEqual(['reviewer-0', 'reviewer-1', 'reviewer-2', 'reviewer-3'])
    expect(host.discoverRuntimeCommitMessageModels).toHaveBeenCalledTimes(1)
    expect(value).toEqual(before)
  })

  it('rejects review counts beyond the supported limit before probing assignments', async () => {
    const { chain, input } = plan([
      actor('producer'),
      ...Array.from({ length: 6 }, (_, index) => reviewer(`reviewer-${index}`, 1))
    ])
    const host = runtime(
      discovered(Array.from({ length: 7 }, (_, index) => model(`model-${index}`)))
    )

    await expect(resolveSessionOutcomeDefaultModels(host, chain, input)).rejects.toThrow(
      /five|5|reviewer/i
    )
    expect(host.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled()
  })

  it.each([
    { success: false, error: 'SSH provider unavailable' } as const,
    { ...discovered(), catalogOrigin: 'spec' as const },
    { ...discovered(), models: [] }
  ])(
    'rejects unavailable or unprobed models without changing the plan ($catalogOrigin)',
    async (probe) => {
      const value = plan()
      value.input.outcomes[0]!.actions = [action()]
      const before = structuredClone(value)

      await expect(
        resolveSessionOutcomeDefaultModels(runtime(probe), value.chain, value.input)
      ).rejects.toThrow(/discover|execution host|model/i)
      expect(value).toEqual(before)
    }
  )

  it('does not partially modify caller data if a different provider fails after a successful probe', async () => {
    const value = plan()
    value.input.outcomes[0]!.actions = [action({ agent: 'claude' })]
    const before = structuredClone(value)
    const host = runtime()
    host.discoverRuntimeCommitMessageModels.mockImplementation(async (_selector, agent) =>
      agent === 'codex' ? discovered() : { success: false, error: 'Remote credentials unavailable' }
    )

    await expect(resolveSessionOutcomeDefaultModels(host, value.chain, value.input)).rejects.toThrow()
    expect(value).toEqual(before)
  })

  it('does not fall back to another host when discovery throws', async () => {
    const value = plan()
    const before = structuredClone(value)
    const host = runtime()
    host.discoverRuntimeCommitMessageModels.mockRejectedValue(new Error('SSH disconnected'))

    await expect(resolveSessionOutcomeDefaultModels(host, value.chain, value.input)).rejects.toThrow(
      'SSH disconnected'
    )
    expect(host.discoverRuntimeCommitMessageModels).toHaveBeenCalledExactlyOnceWith(
      'id:remote-folder-id',
      'codex'
    )
    expect(value).toEqual(before)
  })

  it('rejects omitted models for unsupported providers without probing', async () => {
    const { chain, input } = plan([actor('producer', { agent: 'gemini' })])
    const host = runtime()
    await expect(resolveSessionOutcomeDefaultModels(host, chain, input)).rejects.toThrow(/supported/i)
    expect(host.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled()
  })
})
