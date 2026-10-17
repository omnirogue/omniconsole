import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  resolveSessionPrepLaunchChoice,
  sessionPrepLaunchPreferences
} from './session-prep-launch-choice'

const enabled =
  (...agents: TuiAgent[]) =>
  (agent: TuiAgent) =>
    agents.includes(agent)

describe('resolveSessionPrepLaunchChoice', () => {
  it("uses the person's agent, model and effort", () => {
    const choice = resolveSessionPrepLaunchChoice({
      isAgentEnabled: enabled('claude', 'codex'),
      sourceAgent: 'claude',
      choices: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
      recommendedEffort: 'low',
      needsQuestion: false
    })
    expect(choice).toEqual({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', notes: [] })
    expect(sessionPrepLaunchPreferences(choice)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'xhigh'
    })
  })

  it('raises to a recommended high effort but never lowers the agent default', () => {
    expect(
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('claude'),
        sourceAgent: 'claude',
        recommendedEffort: 'high',
        needsQuestion: false
      })
    ).toEqual({ agent: 'claude', effort: 'high', notes: [] })
    for (const recommendedEffort of ['low', 'medium'] as const) {
      expect(
        resolveSessionPrepLaunchChoice({
          isAgentEnabled: enabled('claude'),
          sourceAgent: 'claude',
          recommendedEffort,
          needsQuestion: false
        })
      ).toEqual({ agent: 'claude', notes: [] })
    }
  })

  it('retains the launch default effort when a model alone was explicitly selected', () => {
    expect(
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('codex'),
        sourceAgent: 'codex',
        choices: { model: 'gpt-6-astra' },
        recommendedEffort: 'high',
        route: { provider: 'codex', model: 'gpt-6-luna', effort: 'medium' },
        needsQuestion: false
      })
    ).toEqual({ agent: 'codex', model: 'gpt-6-astra', notes: [] })
  })

  it('launches no preferences when nothing was chosen or recommended', () => {
    const choice = resolveSessionPrepLaunchChoice({
      isAgentEnabled: enabled('claude'),
      sourceAgent: 'claude',
      needsQuestion: false
    })
    expect(sessionPrepLaunchPreferences(choice)).toBeUndefined()
  })

  it('refuses a disabled explicit agent instead of silently substituting', () => {
    expect(() =>
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('claude'),
        sourceAgent: 'claude',
        choices: { agent: 'codex', model: 'gpt-5.5', effort: 'high' },
        needsQuestion: false
      })
    ).toThrow('explicit choice was preserved')
  })

  it('moves an item with no stated agent to Claude when it must ask first', () => {
    expect(
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('claude', 'codex'),
        sourceAgent: 'codex',
        needsQuestion: true
      }).agent
    ).toBe('claude')
    expect(
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('claude', 'codex'),
        sourceAgent: 'claude',
        choices: { agent: 'codex' },
        needsQuestion: true
      }).agent
    ).toBe('codex')
  })

  it('refuses unsupported explicit effort instead of lowering it', () => {
    expect(() =>
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('codex'),
        sourceAgent: 'codex',
        choices: { effort: 'max' },
        needsQuestion: false
      })
    ).toThrow('explicit choice was preserved')
    expect(() =>
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('claude'),
        sourceAgent: 'claude',
        choices: { model: 'haiku', effort: 'high' },
        needsQuestion: false
      })
    ).toThrow('explicit choice was preserved')
  })

  it('applies model choices through existing Gemini and OMP launch catalogs', () => {
    expect(
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('gemini'),
        sourceAgent: 'gemini',
        choices: { model: 'gemini-3.1-pro-preview' },
        needsQuestion: false
      })
    ).toEqual({ agent: 'gemini', model: 'gemini-3.1-pro-preview', notes: [] })
    expect(
      resolveSessionPrepLaunchChoice({
        isAgentEnabled: enabled('omp'),
        sourceAgent: 'omp',
        choices: { model: 'moonshot/kimi-k2.5', effort: 'high' },
        needsQuestion: false
      })
    ).toEqual({ agent: 'omp', model: 'moonshot/kimi-k2.5', effort: 'high', notes: [] })
  })
})

it('marks only an automatic model for account verification, even when effort is pinned', () => {
  expect(
    resolveSessionPrepLaunchChoice({
      isAgentEnabled: () => true,
      sourceAgent: 'codex',
      needsQuestion: false,
      choices: { effort: 'high' },
      route: { provider: 'codex', model: 'gpt-6-luna', effort: 'medium' }
    })
  ).toMatchObject({ model: 'gpt-6-luna', effort: 'high', routedModel: 'gpt-6-luna' })
})
