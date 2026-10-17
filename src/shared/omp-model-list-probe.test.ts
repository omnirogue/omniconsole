import { describe, expect, it } from 'vitest'
import { getAgentModelProbeSpec } from './agent-model-probe-spec'
import { parseOmpModelList } from './omp-model-list-probe'
import { checkAgentLaunchPreferences } from './agent-launch-preference-check'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { sessionOutcomeActionSchema } from './session-outcome-types'

const model = 'openrouter/moonshotai/kimi-k2.5:free'

describe('OMP provider/model identity', () => {
  it('probes the execution host using the pinned CLI JSON contract', () => {
    const spec = getAgentModelProbeSpec('omp')!
    expect(spec.modelDiscovery).toMatchObject({ binary: 'omp', args: ['models', 'ls', '--json'] })
    expect(spec.models).toEqual([])
    expect(
      spec.modelDiscovery!.parse(
        JSON.stringify({
          models: [
            {
              provider: 'openrouter',
              id: 'moonshotai/kimi-k2.5:free',
              selector: model,
              name: 'Kimi'
            },
            { provider: 'moonshot', id: 'kimi-k2.5:free', name: 'Kimi' }
          ]
        })
      )
    ).toEqual([
      { id: model, label: 'Kimi (openrouter)' },
      { id: 'moonshot/kimi-k2.5:free', label: 'Kimi (moonshot)' }
    ])
  })

  it('preserves per-model thinking ladders and explicit non-reasoning metadata', () => {
    const metadata = [
      {
        id: 'anthropic/claude-opus-5',
        reasoning: true,
        thinking: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      { id: 'google/gemini-3.8-flash', reasoning: true, thinking: ['low', 'medium', 'high'] },
      { id: 'example/plain', reasoning: false, thinking: null }
    ]
    expect(
      parseOmpModelList(
        JSON.stringify({
          models: metadata.map((row) => ({ provider: 'openrouter', ...row }))
        })
      )
    ).toEqual(
      metadata.map(({ id, ...row }) => ({
        id: `openrouter/${id}`,
        label: `openrouter/${id}`,
        ...row
      }))
    )
  })

  it('rejects corrupt selectors and explicitly unsupported tools without inventing capabilities', () => {
    expect(
      parseOmpModelList(
        JSON.stringify({
          models: [
            { provider: 'openrouter', id: 'x/y', selector: 'other/x/y' },
            { provider: 'openrouter', id: 'x/z', supportsTools: false },
            { provider: 'openrouter', id: 'x/q', name: 'Unknown capability' },
            { provider: 'openrouter', id: 'x/q', name: 'Unknown capability' },
            { provider: '--provider other', id: 'bad' }
          ]
        })
      )
    ).toEqual([{ id: 'openrouter/x/q', label: 'Unknown capability (openrouter)' }])
    for (const text of ['No models', '{}', '{"models":null}', 'null']) {
      expect(parseOmpModelList(text)).toEqual([])
    }
  })

  it('preserves nested identity in worker validation, saved outcomes and terminal argv', () => {
    expect(checkAgentLaunchPreferences('omp', { model })).toEqual({
      ok: true,
      preferences: { model }
    })
    expect(
      sessionOutcomeActionSchema.parse({
        id: 'action',
        instruction: 'Review',
        conditionIds: ['done'],
        authority: 'existing-user-authority',
        agent: 'omp',
        model
      }).model
    ).toBe(model)
    const launch = resolveAgentLaunchCommand({
      agent: 'omp',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      sessionOptions: { model },
      agentArgs: '--provider old --model old/model',
      sessionOptionsOverrideAgentArgs: true
    })
    expect(launch).toMatchObject({
      ok: true,
      command: `command omp '--model' '${model}'`,
      appliedSessionOptions: { model }
    })
  })

  it('retains the explicit provider/model when resuming the original OMP session', () => {
    expect(
      buildAgentResumeStartupPlan({
        agent: 'omp',
        providerSession: { key: 'session_id', id: 'omp-session' },
        ompResumeFilePath: '/sessions/omp.jsonl',
        cmdOverrides: {},
        platform: 'linux',
        sessionOptions: { model }
      })
    ).toMatchObject({
      launchCommand: `command omp '--model' '${model}' '--resume' '/sessions/omp.jsonl'`,
      sessionOptions: { model }
    })
  })

  it('does not report a selected model when free-form args change its provider', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'omp',
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        sessionOptions: { model },
        agentArgs: '--provider other'
      })
    ).toMatchObject({ ok: true, appliedSessionOptions: {} })
  })
})
