import { describe, expect, it } from 'vitest'
import { assessWorkAgentAvailability, hasUsageFeed } from './work-agent-availability'
import type { ProviderRateLimits } from './rate-limit-types'

const now = 1000000
const usage: ProviderRateLimits = {
  provider: 'codex',
  status: 'ok',
  updatedAt: now,
  error: null,
  session: { usedPercent: 12, windowMinutes: 300, resetsAt: now + 1000, resetDescription: null },
  weekly: null
}
const base = {
  installed: true,
  disabled: false,
  models: [{ id: 'gpt-6-astra', label: 'Astra', options: [] }],
  usage,
  now
}

describe('employee launch availability', () => {
  it('launcher mode admits detected CLIs without usage evidence or model probes', () => {
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, models: null, usage: null })
        .status
    ).toBe('usable')
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, installed: false }).status
    ).toBe('cli-missing')
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, requiresWorkPlan: true }).status
    ).toBe('work-plan-required')
  })
  it('a host-read signed-out login excludes the agent even in launcher mode', () => {
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, signedIn: false }).status
    ).toBe('logged-out')
    expect(assessWorkAgentAvailability({ ...base, signedIn: false }).status).toBe('logged-out')
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, signedIn: true }).status
    ).toBe('usable')
    // Why: missing evidence never grants a launch; an unread or unreported login is unverified.
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, signedIn: null }).status
    ).toBe('unverified')
    // An agent without a login check is unaffected.
    expect(
      assessWorkAgentAvailability({ ...base, skipUsageGating: true, signedIn: undefined }).status
    ).toBe('usable')
    expect(
      assessWorkAgentAvailability({
        ...base,
        skipUsageGating: true,
        signedIn: false,
        disabled: true
      }).status
    ).toBe('disabled')
  })
  it('launcher mode does not remove Fable because another account exhausted its quota', () => {
    const models = [{ id: 'fable', label: 'Fable', options: [] }]
    const result = assessWorkAgentAvailability({
      ...base,
      models,
      skipUsageGating: true,
      usage: { ...usage, fableWeekly: { ...usage.session!, usedPercent: 100 } }
    })
    expect(result.models).toEqual(models)
  })
  it('admits a fresh, installed, authenticated model with quota', () => {
    expect(assessWorkAgentAvailability(base).status).toBe('usable')
  })
  it.each([
    [{ requiresWorkPlan: true }, 'work-plan-required'],
    [{ installed: false }, 'cli-missing'],
    [{ disabled: true }, 'disabled'],
    [{ models: null }, 'model-unavailable'],
    [{ usage: null }, 'unverified'],
    [{ usage: { ...usage, updatedAt: now - 360001 } }, 'unverified'],
    [{ usage: { ...usage, session: null } }, 'unverified'],
    [{ usage: { ...usage, status: 'error' } }, 'health-check-failed'],
    [{ usage: { ...usage, usageMetadata: { failureKind: 'missing-credentials' } } }, 'logged-out'],
    [{ usage: { ...usage, session: { ...usage.session!, usedPercent: 100 } } }, 'quota-exhausted']
  ] as const)('excludes an unusable option: %s', (changes, expected) => {
    const result = assessWorkAgentAvailability({ ...base, ...changes })
    expect(result.status).toBe(expected)
    expect(result.models).toEqual([])
  })
  it.each(['weekly', 'monthly'] as const)(
    'excludes a full %s window, not only the session',
    (key) => {
      const result = assessWorkAgentAvailability({
        ...base,
        usage: { ...usage, [key]: { ...usage.session!, usedPercent: 100 } }
      })
      expect(result.status).toBe('quota-exhausted')
    }
  )
  it.each([
    'network',
    'delegated-refresh-required',
    'refreshable-credentials-without-token'
  ] as const)('does not mistake %s for a logout', (failureKind) => {
    const result = assessWorkAgentAvailability({
      ...base,
      usage: { ...usage, usageMetadata: { failureKind } }
    })
    expect(result.status).toBe('usable')
  })
  it('refuses a presence-only agent whose sign-in and quota nothing can attest to', () => {
    // Why: a detected CLI with no usage evidence (Grok signed out reads the same) is
    // unverified, never launchable — presence is not proof it can run.
    expect(assessWorkAgentAvailability({ ...base, usage: null }).status).toBe('unverified')
  })
  it('Build + Review keeps an installed agent selectable while its usage is unchecked', () => {
    const admit = { ...base, admitUncheckedUsage: true }
    for (const usageReading of [
      null,
      { ...usage, updatedAt: now - 360_001 },
      { ...usage, status: 'fetching' as const, updatedAt: 0 }
    ]) {
      const result = assessWorkAgentAvailability({ ...admit, usage: usageReading })
      expect(result).toMatchObject({ status: 'usable', usageUnchecked: true, models: base.models })
    }
    // A fresh reading is judged as always, and says nothing about being unchecked.
    expect(assessWorkAgentAvailability(admit)).not.toHaveProperty('usageUnchecked')
    expect(
      assessWorkAgentAvailability({
        ...admit,
        usage: { ...usage, session: { ...usage.session!, usedPercent: 100 } }
      }).status
    ).toBe('quota-exhausted')
  })
  it.each([
    [{ usage: { ...usage, usageMetadata: { failureKind: 'missing-credentials' } } }, 'logged-out'],
    [{ usage: { ...usage, status: 'unavailable', updatedAt: now - 360_001 } }, 'unverified'],
    [{ usage: { ...usage, status: 'error', updatedAt: now - 360_001 } }, 'unverified'],
    [{ usage: null, installed: false }, 'cli-missing'],
    [{ usage: null, models: null }, 'model-unavailable']
  ] as const)('Build + Review still excludes what evidence rules out: %s', (changes, expected) => {
    const result = assessWorkAgentAvailability({ ...base, admitUncheckedUsage: true, ...changes })
    expect(result.status).toBe(expected)
    expect(result.models).toEqual([])
  })
  it('keeps a stale reading that showed a spent window excluding until that window resets', () => {
    const stale = now - 360_001
    const spent = { ...usage.session!, usedPercent: 100 }
    const admit = { ...base, admitUncheckedUsage: true }
    for (const window of [
      { ...spent, resetsAt: now + 60_000 },
      { ...spent, resetsAt: null }
    ]) {
      const result = assessWorkAgentAvailability({
        ...admit,
        usage: { ...usage, updatedAt: stale, session: window }
      })
      expect(result).toMatchObject({ status: 'quota-exhausted', models: [] })
    }
    // A window that has reset since proves nothing any more; the agent waits on a new reading.
    expect(
      assessWorkAgentAvailability({
        ...admit,
        usage: { ...usage, updatedAt: stale, weekly: { ...spent, resetsAt: now - 1 } }
      })
    ).toMatchObject({ status: 'usable', usageUnchecked: true })
  })
  it('only agents with a usage feed can ever have their unchecked note cleared', () => {
    for (const agent of ['claude', 'claude-agent-teams', 'codex', 'gemini', 'grok'] as const) {
      expect(hasUsageFeed(agent)).toBe(true)
    }
    for (const agent of ['cursor', 'opencode', 'pi', 'omp', 'aider'] as const) {
      expect(hasUsageFeed(agent)).toBe(false)
    }
  })
  it('never admits unchecked usage for the other surfaces', () => {
    expect(assessWorkAgentAvailability({ ...base, usage: null })).not.toHaveProperty(
      'usageUnchecked'
    )
  })
  it('excludes exhausted Fable without excluding usable Claude models', () => {
    const result = assessWorkAgentAvailability({
      ...base,
      usage: { ...usage, provider: 'claude', fableWeekly: { ...usage.session!, usedPercent: 100 } },
      models: [
        { id: 'claude-fable-5-1[1m]', label: 'Fable', options: [] },
        { id: 'opus[1m]', label: 'Opus', options: [] }
      ]
    })
    expect(result.models.map((model) => model.id)).toEqual(['opus[1m]'])
  })
  it('never lets "Agent default" start a model whose own window is spent', () => {
    const fable = { id: 'fable', label: 'Fable 5.1', options: [], isDefault: true }
    const opus = { id: 'opus', label: 'Opus', options: [] }
    const claude = {
      ...usage,
      provider: 'claude' as const,
      fableWeekly: { ...usage.session!, usedPercent: 100 }
    }
    const result = assessWorkAgentAvailability({ ...base, usage: claude, models: [fable, opus] })
    expect(result).toMatchObject({
      status: 'usable',
      models: [opus],
      unavailableModels: [fable],
      defaultModelUnavailable: true
    })
    // A probe that names a usable default leaves "Agent default" alone.
    const opusDefault = { ...opus, isDefault: true }
    const named = assessWorkAgentAvailability({
      ...base,
      usage: claude,
      models: [{ ...fable, isDefault: false }, opusDefault]
    })
    expect(named).toMatchObject({ models: [opusDefault], unavailableModels: [expect.anything()] })
    expect(named).not.toHaveProperty('defaultModelUnavailable')
  })

  it('judges per-model windows on an old reading too, until they reset', () => {
    const fable = { id: 'fable', label: 'Fable', options: [], isDefault: true }
    const opus = { id: 'opus', label: 'Opus', options: [] }
    const stale = {
      ...usage,
      provider: 'claude' as const,
      updatedAt: now - 360_001,
      fableWeekly: { ...usage.session!, usedPercent: 100, resetsAt: now + 60_000 }
    }
    const admit = { ...base, admitUncheckedUsage: true, models: [fable, opus] }
    expect(assessWorkAgentAvailability({ ...admit, usage: stale })).toMatchObject({
      status: 'usable',
      usageUnchecked: true,
      models: [opus],
      unavailableModels: [fable],
      defaultModelUnavailable: true
    })
    const reset = { ...stale, fableWeekly: { ...stale.fableWeekly, resetsAt: now - 1 } }
    const afterReset = assessWorkAgentAvailability({ ...admit, usage: reset })
    expect(afterReset.models).toEqual([fable, opus])
    expect(afterReset).not.toHaveProperty('unavailableModels')
    // Every model spent is quota exhausted, not a selectable agent whose usage is unchecked.
    const onlyFable = assessWorkAgentAvailability({ ...admit, usage: stale, models: [fable] })
    expect(onlyFable).toMatchObject({ status: 'quota-exhausted', models: [] })
    expect(onlyFable).not.toHaveProperty('usageUnchecked')
  })

  it('does not call a model no quota bucket names out of usage, nor move "Agent default" off it', () => {
    const flash38 = {
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      options: [],
      isDefault: true
    }
    const flash35 = { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', options: [] }
    const pro31 = { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', options: [] }
    const gemini = (proUsed: number): ProviderRateLimits => ({
      ...usage,
      provider: 'gemini',
      buckets: [
        { ...usage.session!, name: '3.5 Flash', usedPercent: 0 },
        { ...usage.session!, name: '3.1 Pro', usedPercent: proUsed }
      ]
    })
    const models = [flash38, flash35, pro31]
    const fresh = assessWorkAgentAvailability({ ...base, usage: gemini(0), models })
    // As before: the unmapped default is not offered, and nothing is out of usage.
    expect(fresh).toMatchObject({ status: 'usable', models: [flash35, pro31] })
    expect(fresh).not.toHaveProperty('unavailableModels')
    expect(fresh).not.toHaveProperty('defaultModelUnavailable')
    // A spent bucket names its own model; the default it does not name stays launchable.
    const spentPro = assessWorkAgentAvailability({ ...base, usage: gemini(100), models })
    expect(spentPro).toMatchObject({ models: [flash35], unavailableModels: [pro31] })
    expect(spentPro).not.toHaveProperty('defaultModelUnavailable')
    // An old reading admits the agent on no evidence, so it keeps the unmapped model.
    const unchecked = assessWorkAgentAvailability({
      ...base,
      admitUncheckedUsage: true,
      usage: { ...gemini(100), updatedAt: now - 360_001 },
      models
    })
    expect(unchecked).toMatchObject({ models: [flash38, flash35], unavailableModels: [pro31] })
  })

  it('uses per-model buckets instead of the most-constrained provider summary', () => {
    const result = assessWorkAgentAvailability({
      ...base,
      usage: {
        ...usage,
        provider: 'gemini',
        session: { ...usage.session!, usedPercent: 100 },
        buckets: [
          { ...usage.session!, name: 'Pro', usedPercent: 100 },
          { ...usage.session!, name: 'Flash', usedPercent: 20 }
        ]
      },
      models: [
        { id: 'gemini-pro', label: 'Pro', options: [] },
        { id: 'gemini-flash', label: 'Flash', options: [] },
        { id: 'unknown', label: 'Unknown', options: [] }
      ]
    })
    expect(result.models.map((model) => model.id)).toEqual(['gemini-flash'])
  })
})

it('uses host-attested OMP models without borrowing another provider usage receipt', () => {
  const attested = {
    ...base,
    openrouterRouting: true,
    usage: null,
    models: [
      {
        id: 'openrouter/vendor/exact',
        label: 'Exact',
        options: [],
        openrouterRouting: 'omp-openrouter-routing-v1' as const
      }
    ]
  }
  expect(assessWorkAgentAvailability(attested).status).toBe('usable')
  expect(assessWorkAgentAvailability({ ...attested, models: base.models }).status).toBe(
    'unverified'
  )
  expect(assessWorkAgentAvailability({ ...attested, installed: false }).status).toBe('cli-missing')
  expect(assessWorkAgentAvailability({ ...attested, requiresWorkPlan: true }).status).toBe(
    'work-plan-required'
  )
})
