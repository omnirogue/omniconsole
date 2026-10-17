import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { createClaudeCatalogOptions } from './agent-session-option-catalog-claude-codex'
import { withClaudeUltracode } from './claude-ultracode-effort'

function effortValues(options: ReturnType<typeof createClaudeCatalogOptions>): string[] {
  const effort = options.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
}

describe('Claude ultracode effort', () => {
  it('joins the ladder wherever the CLI advertises xhigh, and nowhere else', () => {
    // Measured on Claude Code 2.1.236: list_models never names ultracode, yet
    // `--effort ultracode` and `/effort ultracode` are accepted on every xhigh model.
    expect(withClaudeUltracode(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(withClaudeUltracode(['low', 'medium', 'high'])).toEqual(['low', 'medium', 'high'])
    expect(withClaudeUltracode([])).toEqual([])
  })

  it('is not doubled when a list already carries it', () => {
    expect(withClaudeUltracode(['xhigh', 'ultracode'])).toEqual(['xhigh', 'ultracode'])
  })

  it('is offered on a probed model that takes xhigh', () => {
    expect(
      effortValues(
        createClaudeCatalogOptions({ effortLevelIds: ['low', 'medium', 'high', 'xhigh', 'max'] })
      )
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      effortValues(createClaudeCatalogOptions({ effortLevelIds: ['low', 'medium', 'high'] }))
    ).toEqual(['low', 'medium', 'high'])
  })

  it('is offered on the seed families that take xhigh and launches as --effort ultracode', () => {
    const catalog = getAgentSessionOptionCatalog('claude')!
    const opus = catalog.models.find((model) => model.id === 'opus')!
    const effort = opus.options.find((option) => option.id === 'effort')!
    // Exact order: ultracode is the last rung, after max.
    expect(effort.kind.type === 'select' ? effort.kind.choices.map((c) => c.value) : []).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(effort.apply?.launchArgs?.('ultracode')).toEqual(['--effort', 'ultracode'])
    expect(
      effort.apply?.midSession?.kind === 'command'
        ? effort.apply.midSession.build('ultracode')
        : null
    ).toBe('/effort ultracode')
    // Haiku has no effort control at all, so it gets no ultracode either.
    const haiku = catalog.models.find((model) => model.id === 'haiku')!
    expect(haiku.options.some((option) => option.id === 'effort')).toBe(false)
  })
})
