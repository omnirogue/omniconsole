import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { resolveNativeChatSessionOptionDefaults } from './native-chat-session-option-defaults'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import { buildAgentStartupPlan } from './tui-agent-startup'

// Regression for 2026-09-19: Codex panes launched with a model preference but no
// effort preference ran at the seed catalog's `medium` while every config.toml said
// `high`. An unset effort must inherit the home's config; an explicit one is honored.
describe('codex effort inherits the home config when no preference is stored', () => {
  it('emits only the model flag for a model-only preference', () => {
    expect(resolveAgentSessionOptionLaunch('codex', { model: 'gpt-6-astra' })).toEqual({
      args: ['-m', 'gpt-6-astra'],
      appliedValues: { model: 'gpt-6-astra' }
    })
    // Unknown models fall back to the generic effort menu; still no synthesized flag.
    expect(resolveAgentSessionOptionLaunch('codex', { model: 'gpt-7-preview' }).args).toEqual([
      '-m',
      'gpt-7-preview'
    ])
  })

  it('honors an explicit effort preference', () => {
    expect(
      resolveAgentSessionOptionLaunch('codex', { model: 'gpt-6-astra', effort: 'high' })
    ).toEqual({
      args: ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high'],
      appliedValues: { model: 'gpt-6-astra', effort: 'high' }
    })
  })

  it('keeps a stored model-only native chat preference free of an effort flag', () => {
    const defaults = resolveNativeChatSessionOptionDefaults(
      { codex: { model: 'gpt-6-astra', valuesByModel: {} } },
      'codex'
    )
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'Review ads',
      cmdOverrides: {},
      platform: 'darwin',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      sessionOptions: defaults
    })
    expect(plan?.launchCommand).toBe(
      "codex '-m' 'gpt-6-astra' '--dangerously-bypass-approvals-and-sandbox' 'Review ads'"
    )
    expect(plan?.launchCommand).not.toContain('model_reasoning_effort')
    expect(plan?.sessionOptions).toEqual({ model: 'gpt-6-astra' })
  })

  it('does not present the seed default as the effort a draft will apply', () => {
    const record = createNativeChatSessionOptionRecord('codex')
    record.model = { value: 'gpt-6-astra', source: 'applied' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'draft',
      modelLabel: 'Model'
    })
    const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort).toMatchObject({ valueSource: 'unknown' })
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : 'x').toBeUndefined()
  })
})
