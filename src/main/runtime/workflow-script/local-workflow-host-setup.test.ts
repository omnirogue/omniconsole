import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../../../shared/agent-session-option-catalog'
import type { LocalWorkflowSeatCapacity } from '../../../shared/local-workflow-seat-capacity'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import { LocalWorkflowGraphTeamSchema } from '../rpc/methods/local-workflow-start-schema'
import { localWorkflowGraphTeam, localWorkflowSetupDefaults } from './local-workflow-host-setup'

function entry(
  agent: LocalWorkflowSeatCatalog['agent'],
  accountId: string,
  capacity?: LocalWorkflowSeatCapacity
): LocalWorkflowSeatCatalog {
  return {
    agent,
    accountId,
    accountLabel: accountId,
    accountHome: `/homes/${accountId}`,
    policyRevision: 'p',
    ...(capacity ? { capacity } : {}),
    models: [
      {
        catalog: { id: `${agent}-model`, isDefault: true, options: [] } as unknown as CatalogModel,
        resolvedModelId: `${agent}-model`,
        lineage: agent === 'claude' ? 'anthropic' : agent === 'codex' ? 'openai' : 'xai'
      }
    ]
  }
}

const codexAccount = (catalog: LocalWorkflowSeatCatalog[]) =>
  localWorkflowSetupDefaults('council', catalog, 4).defaults.seats.find(
    (seat) => seat.agent === 'codex'
  )?.accountId

describe('default workflow seats', () => {
  it('keeps frozen-only routes available to Audit without offering them to streamed graphs', () => {
    const catalog = [
      { ...entry('grok', 'grok-account'), streamUnavailableReason: 'Stream unavailable' }
    ]
    expect(localWorkflowSetupDefaults('council', catalog, 4).defaults.seats).toEqual([])
    expect(localWorkflowSetupDefaults('discover', catalog, 4, 'frozen').defaults.seats).toEqual([
      { id: 'seat-1', agent: 'grok', accountId: 'grok-account' }
    ])
  })
  it('passes over an exhausted system Codex for a managed account with fresh capacity', () => {
    // The runs that lost 76, 62 and 34 Codex calls: ~/.codex at 100% of its 5-hour window,
    // managed accounts at 0–6% of their week.
    const catalog = [
      entry('claude', 'system:claude', { state: 'fresh', remainingPercent: 70 }),
      entry('codex', 'system:codex', { state: 'limited' }),
      entry('codex', 'managed:m1', { state: 'fresh', remainingPercent: 94 }),
      entry('codex', 'managed:m2', { state: 'fresh', remainingPercent: 100 })
    ]
    expect(codexAccount(catalog)).toBe('managed:m2')
  })

  it('prefers the most capacity even over a fresh system login', () => {
    const catalog = [
      entry('claude', 'system:claude'),
      entry('codex', 'system:codex', { state: 'fresh', remainingPercent: 20 }),
      entry('codex', 'managed:m1', { state: 'fresh', remainingPercent: 90 })
    ]
    expect(codexAccount(catalog)).toBe('managed:m1')
  })

  it('keeps the first eligible account when no reading is known, as before', () => {
    const catalog = [
      entry('claude', 'system:claude'),
      entry('codex', 'system:codex'),
      entry('codex', 'managed:m1', { state: 'unknown' }),
      entry('grok', 'system:grok')
    ]
    const { defaults } = localWorkflowSetupDefaults('council', catalog, 4)
    expect(defaults.seats.map((seat) => [seat.agent, seat.accountId])).toEqual([
      ['claude', 'system:claude'],
      ['codex', 'system:codex'],
      ['grok', 'system:grok']
    ])
  })

  it('never defaults to an unavailable account, however much capacity it shows', () => {
    const catalog = [
      entry('claude', 'system:claude'),
      entry('codex', 'system:codex'),
      {
        ...entry('codex', 'managed:m1', { state: 'fresh', remainingPercent: 100 }),
        unavailableReason: 'The selected account directory is unavailable.'
      }
    ]
    expect(codexAccount(catalog)).toBe('system:codex')
  })
})

describe('workflow graph team', () => {
  // 15 Oct 2026: a Mac with all six routes set up refused every headless run ("Too big:
  // expected array to have <=5 items"): the team holds one seat per route, the schema allowed five.
  const everyRoute = [
    entry('claude', 'claude-account'),
    entry('codex', 'codex-account'),
    entry('grok', 'grok-account'),
    entry('gemini', 'gemini-account'),
    entry('openrouter', 'openrouter-one'),
    entry('openrouter', 'openrouter-two'),
    entry('ollama', 'ollama-local')
  ]

  it('holds each route once, however many accounts a route has', () => {
    const team = localWorkflowGraphTeam(everyRoute, 4)
    expect(team.map((seat) => seat.id)).toEqual([
      'claude',
      'codex',
      'grok',
      'gemini',
      'openrouter',
      'ollama'
    ])
  })

  it('fits the start schema with every route set up', () => {
    const team = localWorkflowGraphTeam(everyRoute, 4)
    expect(LocalWorkflowGraphTeamSchema.safeParse(team).success).toBe(true)
    expect(LocalWorkflowGraphTeamSchema.safeParse([...team, team[0]]).success).toBe(false)
  })
})
