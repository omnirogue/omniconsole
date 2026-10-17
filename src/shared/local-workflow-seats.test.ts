import { describe, expect, it } from 'vitest'
import {
  localWorkflowDraftStreams,
  resolveLocalWorkflowSeat,
  streamedLocalWorkflowCatalog,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice
} from './local-workflow-seats'

function entry(
  agent: LocalWorkflowSeatChoice['agent'],
  lineage: LocalWorkflowSeatCatalog['models'][number]['lineage']
): LocalWorkflowSeatCatalog {
  return {
    agent,
    accountId: `${agent}-account`,
    accountLabel: agent,
    accountHome: `/accounts/${agent}`,
    policyRevision: 'verified-test-route-v1',
    models: [
      {
        catalog: {
          id: 'alias',
          label: 'Model',
          isDefault: true,
          options: [
            {
              id: 'effort',
              label: 'Effort',
              category: 'thought_level',
              kind: {
                type: 'select',
                choices: [
                  { value: 'low', label: 'Low' },
                  { value: 'high', label: 'High' }
                ],
                defaultValue: 'low'
              },
              apply: {}
            }
          ]
        },
        resolvedModelId: `${agent}-concrete`,
        lineage
      }
    ]
  }
}
function fixture() {
  const catalog = [entry('claude', 'anthropic'), entry('codex', 'openai'), entry('grok', 'xai')]
  const seats = catalog.map(({ agent, accountId }) => ({ id: agent, agent, accountId }))
  return { catalog, seats }
}
describe('local workflow model and effort resolution', () => {
  it('freezes exact model IDs and advertised default efforts for all seats', () => {
    const { catalog, seats } = fixture()
    const resolved = seats.map((seat) => resolveLocalWorkflowSeat(seat, catalog))
    expect(resolved.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: 'claude-concrete', effort: 'low' },
      { model: 'codex-concrete', effort: 'low' },
      { model: 'grok-concrete', effort: 'low' }
    ])
    catalog[0].models[0].resolvedModelId = 'later-default'
    expect(resolved[0].model).toBe('claude-concrete')
  })
  it('preserves an explicit effort and account', () => {
    const { catalog, seats } = fixture()
    expect(
      resolveLocalWorkflowSeat({ ...seats[0], model: 'alias', effort: 'high' }, catalog)
    ).toMatchObject({ accountId: 'claude-account', effort: 'high' })
  })
  it.each([
    'account',
    'model',
    'effort',
    'default',
    'lineage',
    'policy',
    'unavailable',
    'ambiguous'
  ])('refuses %s gaps rather than substituting', (gap) => {
    const { catalog, seats } = fixture()
    const choice: LocalWorkflowSeatChoice = { ...seats[0] }
    if (gap === 'account') {
      choice.accountId = 'other'
    }
    if (gap === 'model') {
      choice.model = 'missing'
    }
    if (gap === 'effort') {
      choice.effort = 'ultra'
    }
    if (gap === 'default') {
      catalog[0].models[0].catalog.isDefault = false
    }
    if (gap === 'lineage') {
      catalog[0].models[0].lineage = 'unknown'
    }
    if (gap === 'policy') {
      catalog[0].policyRevision = ''
    }
    if (gap === 'unavailable') {
      catalog[0].unavailableReason = 'Authentication expired'
    }
    if (gap === 'ambiguous') {
      catalog.push(catalog[0])
    }
    expect(() => resolveLocalWorkflowSeat(choice, catalog)).toThrow()
  })
  it('names the provider, not the internal seat id, when a seat is unavailable', () => {
    const { catalog, seats } = fixture()
    catalog[2].unavailableReason = 'Sign in to Grok (grok login) to use it in workflows.'
    expect(() => resolveLocalWorkflowSeat(seats[2], catalog)).toThrow(
      'Grok: Sign in to Grok (grok login) to use it in workflows.'
    )
  })
})

describe('streamed launch availability', () => {
  it('streams every current Council and workspace read, never working agents', () => {
    expect(localWorkflowDraftStreams('council', {})).toBe(true)
    expect(localWorkflowDraftStreams('council', { access: 'frozen' })).toBe(true)
    expect(localWorkflowDraftStreams('discover', { access: 'workspace-read' })).toBe(true)
    // Frozen Discover calls keep the legacy argv, which starts the CLI on PATH.
    expect(localWorkflowDraftStreams('discover', { access: 'frozen' })).toBe(false)
    for (const preset of ['council', 'discover'] as const) {
      expect(localWorkflowDraftStreams(preset, { capability: 'working-agent' })).toBe(false)
    }
  })

  it('makes a route that cannot stream unavailable only to streaming drafts', () => {
    const { catalog, seats } = fixture()
    const grok = catalog.findIndex((candidate) => candidate.agent === 'grok')
    catalog[grok] = { ...catalog[grok], streamUnavailableReason: 'Sign in to Grok.' }
    // Working agents and follow-ups start the CLI on PATH, so Grok still resolves for them.
    expect(resolveLocalWorkflowSeat(seats[grok], catalog).agent).toBe('grok')
    const streamed = streamedLocalWorkflowCatalog(catalog)
    expect(() => resolveLocalWorkflowSeat(seats[grok], streamed)).toThrow('Grok: Sign in to Grok.')
    expect(streamed.filter((candidate) => candidate.unavailableReason)).toHaveLength(1)
    // A route that cannot run at all keeps its own reason.
    catalog[grok] = { ...catalog[grok], unavailableReason: 'Grok CLI is not installed.' }
    expect(streamedLocalWorkflowCatalog(catalog)[grok].unavailableReason).toBe(
      'Grok CLI is not installed.'
    )
  })
})
