import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SessionChain } from '../../../shared/session-chain-types'
import { buildSessionTeamSummary } from './session-team-summary'

function status(paneKey: string, extra: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    stateHistory: [],
    ...extra
  }
}

const LEAD = 'tab-a:leaf-lead'

describe('what the team is actually doing right now', () => {
  const seats = (extra: Record<string, unknown> = {}) =>
    ({
      id: 'chain_live',
      steps: [
        {
          id: 'a',
          agent: 'codex',
          prompt: 'a',
          status: 'launched',
          group: 'build',
          launchedPaneKey: 'tab-a:1'
        },
        {
          id: 'b',
          agent: 'codex',
          prompt: 'b',
          status: 'launched',
          group: 'build',
          launchedPaneKey: 'tab-a:2'
        },
        { id: 'c', agent: 'codex', prompt: 'c', status: 'queued', group: 'build' }
      ],
      outcomeSet: { outcomes: [], continuation: {} },
      ...extra
    }) as unknown as SessionChain

  it('counts the seats that are running, not the groups the plan authored', () => {
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain: seats(),
      statusByPaneKey: new Map([['tab-a:1', status('tab-a:1', { state: 'working' })]])
    })

    // Three seats share one authored group; one of them has an agent on it.
    expect(summary.parallelGroups).toBe(1)
    expect(summary.runningSeats).toBe(2)
    expect(summary.plannedCount).toBe(1)
  })

  it('leaves out the seats a newer plan version replaced', () => {
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain: seats({
        planVersion: 2,
        steps: [
          { id: 'old', agent: 'codex', prompt: 'old', status: 'queued', planVersion: 1 },
          { id: 'new', agent: 'codex', prompt: 'new', status: 'queued', planVersion: 2 }
        ]
      })
    })

    expect(summary.members.map((member) => member.key)).toEqual(['step:new'])
  })

  it('says what the chain may run at once, and that a card-bound one may not', () => {
    const ordinary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain: seats(),
      maxConcurrentAgents: 5
    })
    expect(ordinary.capacity).toEqual({ limit: 5, cardBound: false, label: 'up to 5 at a time' })

    const admitted = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain: seats({ outcomeSet: { outcomes: [], continuation: { taskId: 'btk_1' } } }),
      maxConcurrentAgents: 5
    })
    expect(admitted.capacity).toEqual({
      limit: 1,
      cardBound: true,
      label: '1 at a time \u00b7 card-bound'
    })

    // Filing an outcome under a card is not admission: the chain keeps its own capacity.
    const filed = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain: seats({
        outcomeSet: {
          outcomes: [{ id: 'o', taskRef: { taskId: 'btk_1', attachedAt: 1 } }],
          continuation: {}
        }
      }),
      maxConcurrentAgents: 5
    })
    expect(filed.capacity).toEqual(ordinary.capacity)
  })

  it('falls back to the default concurrency when no setting is passed', () => {
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain: seats()
    })
    expect(summary.capacity.limit).toBe(3)
  })
})
