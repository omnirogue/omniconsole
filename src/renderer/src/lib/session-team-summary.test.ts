import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SessionChain } from '../../../shared/session-chain-types'
import { buildSessionTeamSummary, chainLaunchedPaneKeys } from './session-team-summary'

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

describe('buildSessionTeamSummary', () => {
  it('reads planned seats, parallel groups, reviewers, rounds and fleet placement from the workflow graph', () => {
    const chain = {
      id: 'chain_1',
      steps: [],
      outcomeSet: {
        outcomes: [],
        workflow: {
          preview: {
            graph: {
              nodes: [
                {
                  key: 'build',
                  title: 'Build',
                  actor_type: 'ai',
                  provider: 'codex',
                  model: 'gpt-5',
                  effort: 'high',
                  loop_stage: { role: 'producer', round: 0 }
                },
                {
                  key: 'r1',
                  title: 'Review A',
                  actor_type: 'ai',
                  provider: 'claude',
                  model: 'opus',
                  parallel_group: 'review',
                  loop_stage: { role: 'participant', round: 1, max_rounds: 3 },
                  placement: 'fleet',
                  machine: 'mw0003'
                },
                {
                  key: 'r2',
                  title: 'Review B',
                  actor_type: 'ai',
                  provider: 'grok',
                  model: 'grok-4',
                  parallel_group: 'review',
                  loop_stage: { role: 'participant', round: 1, max_rounds: 3 },
                  placement: 'local'
                },
                {
                  key: 'ask',
                  title: 'Ask Sal',
                  actor_type: 'human',
                  actor_id: 'emp_sal'
                }
              ]
            }
          }
        }
      }
    } as unknown as SessionChain
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain
    })
    expect(summary.members.map((member) => [member.role, member.agent, member.state])).toEqual([
      ['producer', 'codex', 'planned'],
      ['reviewer', 'claude', 'planned'],
      ['reviewer', 'grok', 'planned']
    ])
    expect(summary.plannedCount).toBe(3)
    expect(summary.parallelGroups).toBe(1)
    expect(summary.sequentialCount).toBe(1)
    expect(summary.reviewerSeats).toBe(2)
    expect(summary.maxRounds).toBe(3)
    expect(summary.placements).toEqual(['fleet:mw0003', 'local'])
    expect(summary.members[0]).toMatchObject({
      model: 'gpt-5',
      effort: 'high'
    })
  })

  it('falls back to chain steps and marks launched steps with their live state and SSH placement', () => {
    const chain = {
      id: 'chain_2',
      hostId: 'ssh:box-1',
      steps: [
        {
          id: 's1',
          agent: 'codex',
          prompt: 'p',
          status: 'launched',
          launchedPaneKey: 'tab-b:leaf-1',
          model: 'gpt-5'
        },
        {
          id: 's2',
          agent: 'claude',
          prompt: 'p',
          status: 'queued',
          group: 'g',
          review: {
            groupId: 'g',
            reviewerId: 'r',
            round: 1,
            maxRounds: 2,
            candidateVersion: 'v'
          }
        },
        {
          id: 's3',
          agent: 'claude',
          prompt: 'p',
          status: 'queued',
          reviewRepair: { groupId: 'g', afterRound: 1, candidateVersion: 'v' }
        },
        { kind: 'handoff', id: 'h', status: 'queued', handoff: {} }
      ]
    } as unknown as SessionChain
    expect(chainLaunchedPaneKeys(chain)).toEqual(['tab-b:leaf-1'])
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain,
      statusByPaneKey: new Map([
        ['tab-b:leaf-1', status('tab-b:leaf-1', { state: 'blocked', model: 'gpt-5.1' })]
      ])
    })
    expect(summary.members.map((member) => [member.role, member.state, member.placement])).toEqual([
      ['worker', 'blocked', 'ssh:box-1'],
      ['reviewer', 'planned', 'ssh:box-1'],
      ['repair', 'planned', 'ssh:box-1']
    ])
    expect(summary.members[0]!.model).toBe('gpt-5.1')
    expect(summary.members[1]!.round).toEqual({ index: 1, total: 2 })
    expect(summary.liveCount).toBe(1)
  })

  it('merges launched step status into the planned graph so a running reviewer reads as running', () => {
    const chain = {
      id: 'chain_3',
      steps: [
        {
          id: 's1',
          agent: 'codex',
          prompt: 'p',
          status: 'launched',
          launchedPaneKey: 'tab-b:p1'
        },
        {
          id: 's2',
          agent: 'claude',
          prompt: 'p',
          status: 'launched',
          launchedPaneKey: 'tab-b:p2',
          review: {
            groupId: 'g',
            reviewerId: 'r1',
            round: 1,
            maxRounds: 2,
            candidateVersion: 'v'
          }
        },
        {
          id: 's3',
          agent: 'grok',
          prompt: 'p',
          status: 'queued',
          review: {
            groupId: 'g',
            reviewerId: 'r2',
            round: 1,
            maxRounds: 2,
            candidateVersion: 'v'
          }
        }
      ],
      outcomeSet: {
        outcomes: [],
        workflow: {
          stages: [
            {
              key: 'stage_build',
              stepIds: ['s1'],
              outcomeIds: [],
              actionIds: []
            },
            {
              key: 'stage_review',
              stepIds: ['s2', 's3'],
              outcomeIds: [],
              actionIds: [],
              reviewGroupId: 'g'
            }
          ],
          preview: {
            graph: {
              nodes: [
                {
                  key: 'stage_build',
                  title: 'Build',
                  actor_type: 'ai',
                  provider: 'codex',
                  model: 'gpt-5',
                  loop_stage: { role: 'producer', round: 0 }
                },
                {
                  key: 'review_r1',
                  title: 'Review A',
                  actor_type: 'ai',
                  provider: 'claude',
                  model: 'opus',
                  parallel_group: 'review',
                  loop_stage: {
                    role: 'participant',
                    stage_key: 'stage_review',
                    round: 1,
                    max_rounds: 2
                  }
                },
                {
                  key: 'review_r2',
                  title: 'Review B',
                  actor_type: 'ai',
                  provider: 'grok',
                  model: 'grok-4',
                  parallel_group: 'review',
                  loop_stage: {
                    role: 'participant',
                    stage_key: 'stage_review',
                    round: 1,
                    max_rounds: 2
                  }
                }
              ]
            }
          }
        }
      }
    } as unknown as SessionChain
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain,
      statusByPaneKey: new Map([
        ['tab-b:p1', status('tab-b:p1', { state: 'working', model: 'gpt-5.2' })],
        ['tab-b:p2', status('tab-b:p2', { state: 'blocked', model: 'opus-5' })]
      ])
    })
    expect(summary.members.map((member) => [member.role, member.state, member.model])).toEqual([
      ['producer', 'working', 'gpt-5.2'],
      ['reviewer', 'blocked', 'opus-5'],
      ['reviewer', 'planned', 'grok-4']
    ])
    expect(summary.plannedCount).toBe(1)
    expect(summary.liveCount).toBe(2)
    expect(summary.reviewerSeats).toBe(2)
  })

  it('reads a launched step with no live row as waiting, never as planned', () => {
    const chain = {
      id: 'chain_4',
      steps: [
        {
          id: 's1',
          agent: 'codex',
          prompt: 'p',
          status: 'launched',
          launchedPaneKey: 'tab-b:gone'
        }
      ],
      outcomeSet: {
        outcomes: [],
        workflow: {
          stages: [
            {
              key: 'stage_build',
              stepIds: ['s1'],
              outcomeIds: [],
              actionIds: []
            }
          ],
          preview: {
            graph: {
              nodes: [
                {
                  key: 'stage_build',
                  title: 'Build',
                  actor_type: 'ai',
                  provider: 'codex'
                }
              ]
            }
          }
        }
      }
    } as unknown as SessionChain
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: status(LEAD),
      orchestrationChildren: [],
      chain
    })
    expect(summary.members.map((member) => member.state)).toEqual(['waiting'])
    expect(summary.plannedCount).toBe(0)
  })

  it('adds live orchestration workers and in-process subagents without a plan', () => {
    const entry = status(LEAD, {
      subagents: [
        {
          id: 'sa1',
          agentType: 'Explore',
          model: 'haiku',
          state: 'working',
          startedAt: 1,
          description: 'scan repo'
        }
      ]
    })
    const worker = status('tab-c:leaf-w', {
      agentType: 'codex',
      state: 'done',
      orchestration: {
        taskId: 't',
        dispatchId: 'd',
        parentPaneKey: LEAD,
        displayName: 'Fix tests'
      }
    })
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry,
      orchestrationChildren: [worker],
      chain: null
    })
    expect(summary.members.map((member) => [member.role, member.label])).toEqual([
      ['worker', 'Fix tests'],
      ['subagent', 'scan repo']
    ])
    expect(summary.liveCount).toBe(1)
    expect(summary.plannedCount).toBe(0)
  })

  it('pairs same-provider seats by exact model, whatever order the graph lists them in', () => {
    const reviewStep = (id: string, model: string) => ({
      id,
      agent: 'claude',
      model,
      prompt: 'p',
      status: 'launched',
      launchedPaneKey: `tab-b:${id}`,
      review: { groupId: 'g', reviewerId: id, round: 1, maxRounds: 1, candidateVersion: 'v' }
    })
    const reviewNode = (key: string, title: string, model: string) => ({
      key,
      title,
      actor_type: 'ai',
      provider: 'claude',
      model,
      loop_stage: { role: 'participant', stage_key: 'review', round: 1, max_rounds: 1 }
    })
    const chain = {
      id: 'chain_5',
      steps: [reviewStep('opus', 'opus'), reviewStep('sonnet', 'sonnet')],
      outcomeSet: {
        outcomes: [],
        workflow: {
          stages: [{ key: 'review', stepIds: ['opus', 'sonnet'], outcomeIds: [], actionIds: [] }],
          // Why: the graph lists Sonnet first while the stage lists Opus first.
          preview: {
            graph: {
              nodes: [
                reviewNode('sonnet-node', 'Sonnet seat', 'sonnet'),
                reviewNode('opus-node', 'Opus seat', 'opus')
              ]
            }
          }
        }
      }
    } as unknown as SessionChain
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain,
      statusByPaneKey: new Map([
        ['tab-b:opus', status('tab-b:opus', { state: 'blocked', model: 'opus' })],
        ['tab-b:sonnet', status('tab-b:sonnet', { state: 'working', model: 'sonnet' })]
      ])
    })
    expect(summary.members.map((member) => [member.label, member.model, member.state])).toEqual([
      ['Sonnet seat', 'sonnet', 'working'],
      ['Opus seat', 'opus', 'blocked']
    ])
  })

  it('leaves a skipped step and a failed plan out of the planned and live counts', () => {
    const skipped = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_6',
        state: 'waiting',
        steps: [{ id: 's1', agent: 'codex', prompt: 'p', status: 'skipped' }]
      } as unknown as SessionChain
    })
    expect(skipped.members[0]!.state).toBe('skipped')
    expect(skipped.plannedCount).toBe(0)
    expect(skipped.liveCount).toBe(0)

    const failed = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_7',
        state: 'failed',
        error: 'spawn refused',
        currentIndex: 0,
        steps: [{ id: 's1', agent: 'codex', prompt: 'p', status: 'queued' }]
      } as unknown as SessionChain
    })
    expect(failed.members[0]!.state).toBe('failed')
    expect(failed.plannedCount).toBe(0)
    expect(failed.liveCount).toBe(0)
  })

  it('binds a producer and the repair that shares its model to their own steps', () => {
    const chain = {
      id: 'chain_8',
      state: 'waiting',
      steps: [
        {
          id: 'producer',
          agent: 'codex',
          model: 'gpt-5.6',
          prompt: 'build',
          status: 'launched',
          launchedPaneKey: 'tab-b:producer'
        },
        {
          id: 'review-r1',
          agent: 'claude',
          model: 'opus',
          prompt: 'review',
          status: 'queued',
          review: { groupId: 'g', reviewerId: 'r', round: 1, maxRounds: 2, candidateVersion: 'v' }
        },
        {
          id: 'repair',
          agent: 'codex',
          model: 'gpt-5.6',
          prompt: 'repair',
          status: 'queued',
          reviewRepair: { groupId: 'g', afterRound: 1, candidateVersion: 'v', consumptionKey: 'k' }
        },
        {
          id: 'review-r2',
          agent: 'claude',
          model: 'opus',
          prompt: 'review',
          status: 'queued',
          review: { groupId: 'g', reviewerId: 'r', round: 2, maxRounds: 2, candidateVersion: 'v2' }
        }
      ],
      outcomeSet: {
        outcomes: [],
        workflow: {
          stages: [
            {
              key: 'stage',
              stepIds: ['producer', 'review-r1', 'repair', 'review-r2'],
              outcomeIds: [],
              actionIds: []
            }
          ],
          // Why: the hub's graph does not list nodes in the stage's step order.
          preview: {
            graph: {
              nodes: [
                {
                  key: 'stage__r2',
                  title: 'Review round 2',
                  actor_type: 'ai',
                  provider: 'claude',
                  model: 'opus',
                  loop_stage: { role: 'participant', stage_key: 'stage', round: 2, max_rounds: 2 }
                },
                {
                  key: 'stage__repair',
                  title: 'Repair after round 1',
                  actor_type: 'ai',
                  provider: 'codex',
                  model: 'gpt-5.6',
                  loop_stage: { role: 'repair', stage_key: 'stage', round: 1, max_rounds: 2 }
                },
                {
                  key: 'stage',
                  title: 'Producer',
                  actor_type: 'ai',
                  provider: 'codex',
                  model: 'gpt-5.6',
                  loop_stage: { role: 'producer', stage_key: 'stage', round: 0, max_rounds: 2 }
                },
                {
                  key: 'stage__r1',
                  title: 'Review round 1',
                  actor_type: 'ai',
                  provider: 'claude',
                  model: 'opus',
                  loop_stage: { role: 'participant', stage_key: 'stage', round: 1, max_rounds: 2 }
                }
              ]
            }
          }
        }
      }
    } as unknown as SessionChain
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain,
      statusByPaneKey: new Map([['tab-b:producer', status('tab-b:producer')]])
    })
    expect(summary.members.map((member) => [member.label, member.role, member.state])).toEqual([
      ['Review round 2', 'reviewer', 'planned'],
      ['Repair after round 1', 'repair', 'planned'],
      ['Producer', 'producer', 'working'],
      ['Review round 1', 'reviewer', 'planned']
    ])
    expect(summary.plannedCount).toBe(3)
    expect(summary.liveCount).toBe(1)
  })

  it('keeps two interchangeable same-round seats on two rows, not four', () => {
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
    const chain = {
      id: 'chain_9',
      state: 'waiting',
      steps: [reviewStep('r1'), reviewStep('r2')],
      outcomeSet: {
        outcomes: [],
        workflow: {
          stages: [{ key: 'review', stepIds: ['r1', 'r2'], outcomeIds: [], actionIds: [] }],
          preview: {
            graph: { nodes: [reviewNode('n2', 'Seat two'), reviewNode('n1', 'Seat one')] }
          }
        }
      }
    } as unknown as SessionChain
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain,
      statusByPaneKey: new Map([
        ['tab-b:r1', status('tab-b:r1', { state: 'blocked' })],
        ['tab-b:r2', status('tab-b:r2', { state: 'working' })]
      ])
    })
    expect(summary.members).toHaveLength(2)
    expect(summary.plannedCount).toBe(0)
    expect(summary.members.map((member) => member.state).sort()).toEqual(['blocked', 'working'])
  })

  it('reads a durably completed step as done and never calls stopped work planned', () => {
    const failedAfterOne = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_10',
        state: 'failed',
        currentIndex: 1,
        steps: [
          { id: 'done-step', agent: 'codex', prompt: 'p', status: 'queued' },
          { id: 'failed-step', agent: 'claude', prompt: 'p', status: 'queued' }
        ],
        outcomeSet: { outcomes: [], completedSteps: ['done-step'] }
      } as unknown as SessionChain
    })
    expect(failedAfterOne.members.map((member) => member.state)).toEqual(['done', 'failed'])
    expect(failedAfterOne.plannedCount).toBe(0)
    expect(failedAfterOne.liveCount).toBe(0)

    const cancelled = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_11',
        state: 'cancelled',
        currentIndex: 0,
        steps: [{ id: 'never-runs', agent: 'codex', prompt: 'p', status: 'queued' }]
      } as unknown as SessionChain
    })
    expect(cancelled.members[0]!.state).toBe('cancelled')
    expect(cancelled.plannedCount).toBe(0)
    expect(cancelled.liveCount).toBe(0)

    const finished = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_12',
        state: 'done',
        currentIndex: 1,
        steps: [{ id: 'done-step', agent: 'codex', prompt: 'p', status: 'queued' }],
        outcomeSet: { outcomes: [], completedSteps: ['done-step'] }
      } as unknown as SessionChain
    })
    expect(finished.members[0]!.state).toBe('done')
    expect(finished.plannedCount).toBe(0)
  })

  it('reads durable completion as done even while a retained pane row still reports working', () => {
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: {
        id: 'chain_13',
        state: 'failed',
        steps: [
          {
            id: 'finished',
            agent: 'codex',
            prompt: 'p',
            status: 'launched',
            launchedPaneKey: 'tab-b:finished'
          }
        ],
        outcomeSet: { outcomes: [], completedSteps: ['finished'] }
      } as unknown as SessionChain,
      statusByPaneKey: new Map([['tab-b:finished', status('tab-b:finished', { state: 'working' })]])
    })
    expect(summary.members[0]!.state).toBe('done')
    expect(summary.liveCount).toBe(0)
  })

  it('reads a stage whose actions completed as done, whatever the chain ended as', () => {
    const chainWith = (state: string) =>
      ({
        id: `chain_action_${state}`,
        state,
        steps: [],
        outcomeSet: {
          outcomes: [],
          attempts: [
            { id: 'a1', outcomeId: 'o', actionId: 'act', state: 'completed' },
            { id: 'a2', outcomeId: 'o', actionId: 'pending-act', state: 'running' }
          ],
          workflow: {
            stages: [
              { key: 'ran', stepIds: [], outcomeIds: ['o'], actionIds: ['act'] },
              { key: 'not-ran', stepIds: [], outcomeIds: ['o'], actionIds: ['pending-act'] }
            ],
            preview: {
              graph: {
                nodes: [
                  { key: 'ran', title: 'Action', actor_type: 'ai', provider: 'codex' },
                  { key: 'not-ran', title: 'Later action', actor_type: 'ai', provider: 'codex' }
                ]
              }
            }
          }
        }
      }) as unknown as SessionChain
    const done = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: chainWith('done')
    })
    expect(done.members.map((member) => member.state)).toEqual(['done', 'skipped'])
    const failed = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: chainWith('failed')
    })
    expect(failed.members.map((member) => member.state)).toEqual(['done', 'failed'])
  })

  it('is empty for a solo session', () => {
    const summary = buildSessionTeamSummary({
      paneKey: LEAD,
      entry: null,
      orchestrationChildren: [],
      chain: null
    })
    expect(summary.members).toEqual([])
    expect(summary.maxRounds).toBeNull()
  })
})
