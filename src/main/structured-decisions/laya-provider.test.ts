import { describe, expect, it, vi } from 'vitest'
import { LAYA_MODEL, LAYA_PROTOCOL, LAYA_SHADOW_URL } from '../../shared/laya-shadow'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { LayaDecisionProvider } from './laya-provider'
import { DecisionService } from './decision-service'
import { parseDecisionConfiguration } from './decision-configuration'

const token = 'a'.repeat(64)
const request: DecisionRequest = {
  capability: 'routine.structured',
  routineId: 'test-routine',
  model: LAYA_MODEL,
  state: 'private input sentinel',
  questions: {
    decision: { type: 'choice', instructions: 'Choose', criteria: { yes: null, no: null } }
  }
}
const result: DecisionResult = {
  provider: 'laya-local',
  model: LAYA_MODEL,
  answers: {
    decision: {
      type: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.8, no: 0.2 },
      confidence: 0.3
    }
  },
  usage: { inputTokens: 8, outputTokens: 0 }
}
const signal = () => new AbortController().signal
const config = () =>
  parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: { 'routine.structured': { mode: 'live' } },
    routines: { 'test-routine': { mode: 'live' } }
  })

describe('pinned Laya provider', () => {
  it('uses authenticated loopback, rejects redirects and preserves confidence separately', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ protocol: LAYA_PROTOCOL, ...result }))
    const provider = new LayaDecisionProvider({ resolveToken: async () => token, fetch: fetcher })
    await expect(provider.evaluate(request, { signal: signal() })).resolves.toEqual(result)
    expect(fetcher).toHaveBeenCalledWith(
      LAYA_SHADOW_URL,
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` })
      })
    )
    const payload = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(Object.keys(payload).sort()).toEqual(['model', 'protocol', 'questions', 'state'])
    expect(JSON.stringify(payload)).not.toContain('test-routine')
  })

  it.each([
    { model: 'laya-latest' },
    { provider: 'typesafe' },
    { protocol: 'other' },
    { answers: { decision: { ...result.answers.decision, choice: 'no' } } },
    { usage: { inputTokens: 8, outputTokens: -1 } }
  ])('rejects unpinned or invalid replies %j', async (override) => {
    const provider = new LayaDecisionProvider({
      resolveToken: async () => token,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ protocol: LAYA_PROTOCOL, ...result, ...override }))
    })
    await expect(provider.evaluate(request, { signal: signal() })).rejects.toMatchObject({
      code: 'invalid_response'
    })
  })

  it('refuses a Jev model, large choices and revoked credentials before network access', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const provider = new LayaDecisionProvider({ resolveToken: async () => token, fetch: fetcher })
    await expect(
      provider.evaluate({ ...request, model: 'jev-1.13.0' }, { signal: signal() })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      provider.evaluate(
        {
          ...request,
          questions: {
            decision: {
              type: 'choice',
              instructions: 'Choose',
              criteria: Object.fromEntries(
                Array.from({ length: 21 }, (_, index) => [`label${index}`, null])
              )
            }
          }
        },
        { signal: signal() }
      )
    ).rejects.toMatchObject({ code: 'input_too_large' })
    const revoked = new LayaDecisionProvider({
      resolveToken: async () => undefined,
      fetch: fetcher
    })
    await expect(revoked.evaluate(request, { signal: signal() })).rejects.toMatchObject({
      code: 'no_api_key'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('cannot enter the live path even when configuration requests live mode', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const provider = new LayaDecisionProvider({ resolveToken: async () => token, fetch: fetcher })
    const service = new DecisionService({ provider, configuration: config })
    await expect(service.evaluate(request)).resolves.toEqual({
      status: 'disabled',
      reason: 'shadow_only'
    })
    expect(fetcher).not.toHaveBeenCalled()
    service.dispose()
  })

  it('runs bounded shadow work and records agreement without raw input', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ protocol: LAYA_PROTOCOL, ...result }))
    const service = new DecisionService({
      provider: new LayaDecisionProvider({ resolveToken: async () => token, fetch: fetcher }),
      configuration: config
    })
    service.observeShadow(request, { comparison: { decision: 'no' } })
    await vi.waitFor(() => expect(service.telemetry.snapshot()).toHaveLength(1))
    expect(service.telemetry.snapshot()[0]).toMatchObject({
      mode: 'shadow',
      status: 'success',
      choices: { decision: { matches: false } }
    })
    expect(JSON.stringify(service.telemetry.snapshot())).not.toContain(request.state)
    expect(JSON.stringify(service.telemetry.snapshot())).not.toContain(token)
    service.dispose()
  })

  it('isolates an observation failure and result mutation from the baseline', async () => {
    const baseline = { ...result, provider: 'typesafe', model: 'jev-1.13.0' }
    const service = new DecisionService({
      configuration: config,
      provider: { id: 'typesafe', evaluate: async () => baseline },
      onEvaluated: (_request, observed) => {
        observed.model = 'changed'
        throw new Error('observer failed')
      }
    })
    await expect(service.evaluate({ ...request, model: baseline.model })).resolves.toMatchObject({
      status: 'evaluated',
      result: { model: baseline.model }
    })
    service.dispose()
  })
})
