import { describe, expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import {
  checkAgentLaunchPreferences,
  launchPreferencesToSessionOptions
} from './agent-launch-preference-check'

describe('checkAgentLaunchPreferences', () => {
  it('passes through an empty selection as no preferences', () => {
    expect(checkAgentLaunchPreferences('claude', undefined)).toEqual({
      ok: true,
      preferences: undefined
    })
    expect(checkAgentLaunchPreferences('claude', { model: '  ', effort: '' })).toEqual({
      ok: true,
      preferences: undefined
    })
  })

  it('accepts a Claude model with an effort the model advertises', () => {
    expect(checkAgentLaunchPreferences('claude', { model: 'opus', effort: 'max' })).toEqual({
      ok: true,
      preferences: { model: 'opus', effort: 'max' }
    })
  })

  it.each(['claude', 'codex'] as const)('accepts %s effort without changing its model', (agent) => {
    expect(checkAgentLaunchPreferences(agent, { effort: 'low' })).toEqual({
      ok: true,
      preferences: { effort: 'low' }
    })
    expect(launchPreferencesToSessionOptions({ effort: 'low' })).toEqual({ effort: 'low' })
  })

  it('retains the model requirement for other agents', () => {
    expect(checkAgentLaunchPreferences('grok', { effort: 'high' })).toMatchObject({
      ok: false,
      message: '--effort requires --model.'
    })
  })

  it('refuses an effort the model does not advertise', () => {
    expect(
      checkAgentLaunchPreferences('grok', { model: 'grok-4.5', effort: 'xhigh' })
    ).toMatchObject({
      ok: false,
      message: 'Agent grok model grok-4.5 does not support effort xhigh.'
    })
  })

  it('accepts grok through its launch catalog', () => {
    expect(checkAgentLaunchPreferences('grok', { model: 'grok-4.6', effort: 'xhigh' })).toEqual({
      ok: true,
      preferences: { model: 'grok-4.6', effort: 'xhigh' }
    })
  })

  it('refuses agents without a launch-safe catalog', () => {
    expect(checkAgentLaunchPreferences('aider', { model: 'anything' })).toMatchObject({
      ok: false,
      message: 'Agent aider does not support launch-time model selection.'
    })
  })

  it('accepts any provider/model id for opencode, whose models come from its config', () => {
    expect(checkAgentLaunchPreferences('opencode', { model: 'ollama/qwen3-coder:30b' })).toEqual({
      ok: true,
      preferences: { model: 'ollama/qwen3-coder:30b' }
    })
  })
})

describe('launchPreferencesToSessionOptions', () => {
  it('maps a validated selection to launch session options', () => {
    expect(launchPreferencesToSessionOptions(undefined)).toBeUndefined()
    expect(launchPreferencesToSessionOptions({ model: 'opus' })).toEqual({ model: 'opus' })
    expect(launchPreferencesToSessionOptions({ model: 'opus', effort: 'max' })).toEqual({
      model: 'opus',
      effort: 'max'
    })
  })
})

it('accepts Gemini model selection and emits only its model flag', () => {
  const checked = checkAgentLaunchPreferences('gemini', { model: 'gemini-3.8-flash' })
  expect(checked).toEqual({ ok: true, preferences: { model: 'gemini-3.8-flash' } })
  if (!checked.ok) {
    throw new Error(checked.message)
  }
  expect(
    resolveAgentSessionOptionLaunch(
      'gemini',
      launchPreferencesToSessionOptions(checked.preferences)
    )
  ).toEqual({ args: ['-m', 'gemini-3.8-flash'], appliedValues: { model: 'gemini-3.8-flash' } })
  expect(
    checkAgentLaunchPreferences('gemini', { model: 'gemini-3.8-flash', effort: 'high' })
  ).toMatchObject({
    ok: false,
    message: 'Agent gemini model gemini-3.8-flash does not support effort high.'
  })
})
