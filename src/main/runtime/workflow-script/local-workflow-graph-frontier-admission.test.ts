import { describe, expect, it } from 'vitest'
import {
  resolveLocalWorkflowSeat,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice,
  type ResolvedLocalWorkflowSeat
} from '../../../shared/local-workflow-seats'
import type { WorkflowAgentSpec, WorkflowSpec } from '../../../shared/workflow-graph'
import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { admitImproveFrontierSeats } from './local-workflow-graph-frontier-admission'
import { graphCallSeatId } from './local-workflow-graph-projection'
import { catalogEntry } from './local-workflow-host.test-fixtures'

const ROUTES = ['claude', 'codex', 'grok'] as const
const TEAM: LocalWorkflowSeatChoice[] = ROUTES.map((agent) => ({
  id: agent,
  agent,
  accountId: `${agent}-account`
}))
const claude = catalogEntry('claude', 'anthropic')
const WITH_OPUS: LocalWorkflowSeatCatalog[] = [
  {
    ...claude,
    models: [
      ...claude.models,
      {
        catalog: { id: 'opus', label: 'Opus 5.5', options: [] },
        resolvedModelId: 'claude-opus-5-5',
        lineage: 'anthropic'
      }
    ]
  },
  catalogEntry('codex', 'openai'),
  catalogEntry('grok', 'xai')
]
const WITHOUT_OPUS = [claude, catalogEntry('codex', 'openai'), catalogEntry('grok', 'xai')]

/** The template's Improve with these improvers; its frontier list names Opus and Astra. */
function improve(agents: WorkflowAgentSpec[]): WorkflowSpec {
  const spec = workflowTemplate('improve', [...ROUTES])
  return {
    ...spec,
    steps: spec.steps.map((step) => (step.id === 'improve' ? { ...step, agents } : step))
  }
}

/** The seats admission resolves for every agent, as graph admission does. */
function resolved(spec: WorkflowSpec, catalog: readonly LocalWorkflowSeatCatalog[]) {
  const seats = new Map<string, ResolvedLocalWorkflowSeat>()
  const agentSeats = Object.fromEntries(
    spec.steps.map((step) => [
      step.id,
      step.agents.map((agent) => {
        const id = agent.model ? `${agent.route}:${agent.model}` : agent.route
        const base = TEAM.find((choice) => choice.agent === agent.route)!
        if (!seats.has(id)) {
          seats.set(
            id,
            resolveLocalWorkflowSeat(
              { ...base, id, ...(agent.model ? { model: agent.model } : {}) },
              catalog
            )
          )
        }
        return id
      })
    ])
  )
  return { seats: [...seats.values()], agentSeats }
}

describe('admitting Improve frontier seats', () => {
  it('verifies each improver its family frontier seat, and keeps the others on their own', () => {
    const spec = improve([{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }])
    expect(spec.repeat?.frontier).toEqual([
      { route: 'claude', model: 'opus' },
      { route: 'codex', model: 'gpt-6-astra' }
    ])
    const before = resolved(spec, WITH_OPUS)
    const admitted = admitImproveFrontierSeats(spec, TEAM, WITH_OPUS, before)
    // Codex's frontier model is not in this catalog and Grok has none: both keep their seat.
    expect(admitted.frontierSeats).toEqual(['claude:opus', 'codex', 'grok'])
    expect(admitted.seats.map((seat) => seat.id)).toEqual([
      ...before.seats.map((seat) => seat.id),
      'claude:opus'
    ])
    expect(admitted.seats.at(-1)).toMatchObject({
      agent: 'claude',
      accountId: 'claude-account',
      model: 'claude-opus-5-5'
    })
  })

  it('pins nothing when no improver would change model', () => {
    const plain = improve([{ route: 'claude' }])
    const unverified = admitImproveFrontierSeats(
      plain,
      TEAM,
      WITHOUT_OPUS,
      resolved(plain, WITHOUT_OPUS)
    )
    expect(unverified.frontierSeats).toBeUndefined()

    const onOpus = improve([{ route: 'claude', model: 'opus' }])
    const already = resolved(onOpus, WITH_OPUS)
    expect(admitImproveFrontierSeats(onOpus, TEAM, WITH_OPUS, already)).toEqual({
      seats: already.seats
    })

    const off = { ...plain, repeat: { ...plain.repeat!, frontier: undefined } }
    const without = resolved(off, WITH_OPUS)
    expect(admitImproveFrontierSeats(off, TEAM, WITH_OPUS, without)).toEqual({
      seats: without.seats
    })
  })

  it('names the frontier seat of a frontier call when the run is projected', () => {
    const snapshot = {
      graph: {
        agentSeats: { improve: ['claude'], judge: ['codex'] },
        frontierSeats: ['claude:opus']
      }
    } as unknown as Parameters<typeof graphCallSeatId>[0]
    expect(graphCallSeatId(snapshot, 'improve/r3/f0')).toBe('claude:opus')
    expect(graphCallSeatId(snapshot, 'improve/r3/a0')).toBe('claude')
    expect(graphCallSeatId(snapshot, 'judge/r3/a0')).toBe('codex')
  })
})
