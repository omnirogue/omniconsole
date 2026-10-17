import { describe, expect, it } from 'vitest'
import { routerCandidateReceipt, selectRouterCandidate } from './session-prep-router-candidates'
import type {
  SessionPrepRouterDecision,
  SessionPrepRouterRequest
} from './session-prep-router-types'

const decision: SessionPrepRouterDecision = {
  provider: 'claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  tier: 'frontier',
  gate: 'rules',
  reason: 'High risk',
  note: ''
}
const request: SessionPrepRouterRequest = {
  brief: 'Task',
  title: 'Task',
  enabledProviders: ['claude', 'codex', 'omp', 'grok', 'gemini'],
  catalog: {
    hostId: 'local',
    observedAt: 1,
    agents: [
      {
        provider: 'codex',
        discovered: true,
        models: [
          { id: 'gpt-6-luna', label: 'Luna' },
          { id: 'gpt-6.1-sol', label: 'Sol' }
        ]
      },
      {
        provider: 'omp',
        discovered: true,
        models: [
          { id: 'moonshot/kimi-k2.5', label: 'Kimi' },
          { id: 'anthropic/claude-opus-5-5', label: 'Opus' }
        ]
      },
      {
        provider: 'gemini',
        discovered: false,
        models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]
      }
    ]
  }
}

describe('existing-tier candidate adaptation', () => {
  it('never routes a high-risk tier to a fast-only family', () => {
    const routed = selectRouterCandidate(request, decision)
    expect(routed).toMatchObject({
      provider: 'omp',
      model: 'anthropic/claude-opus-5-5',
      effort: 'high',
      modelEvidence: 'advertised'
    })
    const unavailable = selectRouterCandidate(
      {
        ...request,
        catalog: { ...request.catalog!, agents: [request.catalog!.agents[0]!] }
      },
      decision
    )
    expect(unavailable).toMatchObject({ status: 'unavailable', blocking: false })
  })

  it('selects discovered Luna for bounded work and Sol for standard work', () => {
    expect(
      selectRouterCandidate(request, { ...decision, tier: 'fast', effort: 'medium' })
    ).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', effort: 'medium' })
    expect(
      selectRouterCandidate(request, { ...decision, tier: 'standard', effort: 'medium' })
    ).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' })
  })

  it('preserves exact user choices across providers and refuses unavailable pins', () => {
    expect(
      selectRouterCandidate(
        { ...request, provider: 'omp', model: 'moonshot/kimi-k2.5', effort: 'high' },
        decision
      )
    ).toMatchObject({ provider: 'omp', model: 'moonshot/kimi-k2.5', effort: 'high' })
    expect(
      selectRouterCandidate({ ...request, provider: 'gemini', model: 'gemini-3.8-flash' }, decision)
    ).toMatchObject({ status: 'unavailable', blocking: false })
    expect(
      selectRouterCandidate(
        { ...request, provider: 'codex', model: 'gpt-6-unavailable', effort: 'max' },
        decision
      )
    ).toMatchObject({ status: 'unavailable', blocking: true })
  })

  it('reports all requested families and does not treat a static seed as available', () => {
    const receipt = routerCandidateReceipt(request)
    expect(receipt).toHaveLength(11)
    expect(receipt.find((row) => row.family === 'Gemini 3.8 Flash')).toMatchObject({
      available: false
    })
    expect(receipt.find((row) => row.family === 'Kimi')).toMatchObject({
      available: true,
      provider: 'omp',
      model: 'moonshot/kimi-k2.5'
    })
    const withArgon: SessionPrepRouterRequest = {
      ...request,
      catalog: {
        ...request.catalog!,
        agents: [
          ...request.catalog!.agents.slice(0, 2),
          {
            provider: 'gemini',
            discovered: true,
            models: [{ id: 'gemini-4-argon', label: 'Gemini 4 Argon' }]
          }
        ]
      }
    }
    expect(selectRouterCandidate(withArgon, decision)).toMatchObject({
      provider: 'gemini',
      model: 'gemini-4-argon'
    })
  })

  it('never applies another host catalog and keeps pending discovery distinct from absence', () => {
    expect(
      selectRouterCandidate(
        { ...request, executionTarget: { path: '/remote', connectionId: 'other' } },
        decision
      )
    ).toMatchObject({ status: 'unavailable', blocking: true })
    expect(
      selectRouterCandidate(
        {
          ...request,
          provider: 'claude',
          catalog: {
            hostId: 'local',
            observedAt: 1,
            agents: [{ provider: 'claude', models: [], discovered: false, error: 'pending' }]
          }
        },
        decision
      )
    ).toMatchObject({ status: 'unavailable', blocking: false })
  })

  it('recognizes discovered Terra5.6 without weakening the frontier floor', () => {
    const terra = {
      ...request,
      catalog: {
        hostId: 'local',
        observedAt: 1,
        agents: [
          {
            provider: 'codex' as const,
            discovered: true,
            models: [{ id: 'gpt-5.6-terra', label: 'Terra' }]
          }
        ]
      }
    }
    expect(
      selectRouterCandidate(terra, { ...decision, tier: 'standard', effort: 'medium' })
    ).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' })
    expect(selectRouterCandidate(terra, decision)).toMatchObject({
      status: 'unavailable',
      blocking: false
    })
  })

  it('resolves only existing estate Astra and Luna aliases against discovered canonical IDs', () => {
    const astra = {
      ...request,
      provider: 'codex' as const,
      model: 'Astra',
      catalog: {
        hostId: 'local',
        observedAt: 1,
        agents: [
          {
            provider: 'codex' as const,
            discovered: true,
            models: [{ id: 'gpt-6-astra', label: 'Astra' }]
          }
        ]
      }
    }
    expect(selectRouterCandidate(astra, decision)).toMatchObject({
      provider: 'codex',
      model: 'gpt-6-astra'
    })
    expect(selectRouterCandidate({ ...astra, provider: 'omp' }, decision)).toMatchObject({
      status: 'unavailable'
    })
    expect(
      selectRouterCandidate(
        { title: 'Task', brief: 'Task', provider: 'codex', model: 'luna' },
        { ...decision, provider: 'codex', model: 'gpt-6-luna' }
      )
    ).toMatchObject({ provider: 'codex', model: 'gpt-6-luna' })
  })

  it.each([
    ['grok', 'grok-code-fast-1'],
    ['omp', 'moonshot/kimi-k2.5'],
    ['kimi', 'kimi-k2.5'],
    ['gemini', 'gemini-3.8-flash']
  ] as const)(
    'retains existing %s launches when no automatic model clears the floor',
    (provider, model) => {
      const scoped = {
        ...request,
        provider,
        enabledProviders: [provider],
        catalog: {
          hostId: 'local',
          observedAt: 1,
          agents: [{ provider, discovered: true, models: [{ id: model, label: model }] }]
        }
      }
      for (const tier of ['standard', 'frontier']) {
        expect(selectRouterCandidate(scoped, { ...decision, tier })).toMatchObject({
          status: 'unavailable',
          blocking: false,
          unrouted: expect.stringContaining('existing launch choices retained')
        })
      }
    }
  )

  it('keeps Fable available for explicit selection without automatically preferring it to Opus', () => {
    const scoped = {
      ...request,
      provider: 'claude' as const,
      catalog: {
        hostId: 'local',
        observedAt: 1,
        agents: [
          {
            provider: 'claude' as const,
            discovered: true,
            models: [
              { id: 'claude-fable-5-1', label: 'Fable' },
              { id: 'claude-opus-5-5', label: 'Opus' }
            ]
          }
        ]
      }
    }
    expect(routerCandidateReceipt(scoped).find((entry) => entry.family === 'Fable')).toMatchObject({
      available: true
    })
    expect(selectRouterCandidate(scoped, { ...decision, tier: 'standard' })).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5-5'
    })
    expect(selectRouterCandidate({ ...scoped, model: 'claude-fable-5-1' }, decision)).toMatchObject(
      { provider: 'claude', model: 'claude-fable-5-1' }
    )
  })

  it('routes standard Claude work to Sonnet and frontier work to Opus', () => {
    const scoped = {
      ...request,
      provider: 'claude' as const,
      enabledProviders: ['claude' as const],
      catalog: {
        hostId: 'local',
        observedAt: 1,
        agents: [
          {
            provider: 'claude' as const,
            discovered: true,
            models: [
              { id: 'opus', label: 'Opus' },
              { id: 'sonnet', label: 'Sonnet' }
            ]
          }
        ]
      }
    }
    expect(
      selectRouterCandidate(scoped, { ...decision, tier: 'standard', effort: 'high' })
    ).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'high' })
    expect(selectRouterCandidate(scoped, decision)).toMatchObject({
      provider: 'claude',
      model: 'opus'
    })
  })

  it('retains the legacy estate route on older hosts without discovery', () => {
    expect(selectRouterCandidate({ title: 'Task', brief: 'Task' }, decision)).toMatchObject({
      ...decision,
      modelEvidence: 'estate-policy'
    })
  })
})
