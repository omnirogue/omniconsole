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

describe('graph seats bind one-to-one to the plan’s steps', () => {
  it('never lets an underspecified seat consume the step a constrained seat needs', () => {
    const reviewStep = (id: string, model: string | undefined, pane: string) => ({
      id,
      agent: 'codex',
      ...(model ? { model } : {}),
      prompt: 'review',
      status: 'launched',
      launchedPaneKey: pane,
      review: { groupId: 'g', reviewerId: id, round: 1, maxRounds: 1, candidateVersion: 'v' }
    })
    const reviewNode = (key: string, title: string, model?: string) => ({
      key,
      title,
      actor_type: 'ai',
      provider: 'codex',
      ...(model ? { model } : {}),
      loop_stage: { role: 'participant', stage_key: 'stage', round: 1, max_rounds: 1 }
    })
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_14',
        state: 'waiting',
        steps: [reviewStep('b', undefined, 'tab-b:b'), reviewStep('a', 'model-a', 'tab-b:a')],
        outcomeSet: {
          outcomes: [],
          workflow: {
            stages: [{ key: 'stage', stepIds: ['b', 'a'], outcomeIds: [], actionIds: [] }],
            preview: {
              graph: {
                nodes: [
                  reviewNode('unknown-model', 'Unspecified seat'),
                  reviewNode('model-b', 'Model B seat', 'model-b')
                ]
              }
            }
          }
        }
      } as unknown as SessionChain,
      statusByPaneKey: new Map([
        ['tab-b:b', status('tab-b:b', { state: 'blocked' })],
        ['tab-b:a', status('tab-b:a', { state: 'working' })]
      ])
    })
    expect(summary.members).toHaveLength(2)
    expect(summary.members.map((member) => member.state).sort()).toEqual(['blocked', 'working'])
    expect(summary.plannedCount).toBe(0)
  })

  it('binds a node that records no provider instead of duplicating its step', () => {
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_15',
        state: 'waiting',
        steps: [
          {
            id: 'step',
            agent: 'codex',
            model: 'gpt',
            prompt: 'build',
            status: 'launched',
            launchedPaneKey: 'tab-b:only'
          }
        ],
        outcomeSet: {
          outcomes: [],
          workflow: {
            stages: [{ key: 'stage', stepIds: ['step'], outcomeIds: [], actionIds: [] }],
            preview: {
              graph: {
                nodes: [
                  {
                    key: 'stage',
                    title: 'Build',
                    actor_type: 'ai',
                    model: 'gpt',
                    loop_stage: { role: 'producer', stage_key: 'stage', round: 0 }
                  }
                ]
              }
            }
          }
        }
      } as unknown as SessionChain,
      statusByPaneKey: new Map([['tab-b:only', status('tab-b:only', { state: 'working' })]])
    })
    expect(summary.members).toHaveLength(1)
    expect(summary.members[0]!.state).toBe('working')
    expect(summary.plannedCount).toBe(0)
  })

  it('withholds the title of interchangeable seats rather than guessing whose state is whose', () => {
    const reviewStep = (id: string) => ({
      id,
      agent: 'claude',
      model: 'opus',
      prompt: 'p',
      status: 'launched',
      launchedPaneKey: `tab-b:${id}`,
      review: { groupId: 'g', reviewerId: id, round: 1, maxRounds: 1, candidateVersion: 'v' }
    })
    const reviewNode = (key: string, title: string) => ({
      key,
      title,
      actor_type: 'ai',
      provider: 'claude',
      model: 'opus',
      loop_stage: { role: 'participant', stage_key: 'review', round: 1, max_rounds: 1 }
    })
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_16',
        state: 'waiting',
        steps: [reviewStep('r1'), reviewStep('r2')],
        outcomeSet: {
          outcomes: [],
          workflow: {
            stages: [{ key: 'review', stepIds: ['r1', 'r2'], outcomeIds: [], actionIds: [] }],
            preview: {
              graph: {
                nodes: [reviewNode('n2', 'Performance review'), reviewNode('n1', 'Security review')]
              }
            }
          }
        }
      } as unknown as SessionChain,
      statusByPaneKey: new Map([
        ['tab-b:r1', status('tab-b:r1', { state: 'blocked' })],
        ['tab-b:r2', status('tab-b:r2', { state: 'working' })]
      ])
    })
    expect(summary.members).toHaveLength(2)
    expect(summary.members.map((member) => member.label)).toEqual([null, null])
    expect(summary.members.map((member) => member.state).sort()).toEqual(['blocked', 'working'])
  })
})
