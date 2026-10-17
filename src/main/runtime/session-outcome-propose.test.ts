import { describe, expect, it } from 'vitest'
import { heuristicProposeWorkPlanDeps, proposeWorkPlan } from './session-outcome-propose'
import { workPlanSentence } from '../../shared/work-plan-sentence'
import type { WorkPlan, WorkPlanContext } from '../../shared/work-plan-types'

function ctx(overrides: Partial<WorkPlanContext> = {}): WorkPlanContext {
  return {
    usableAgents: [
      { agent: 'claude', models: [] },
      { agent: 'codex', models: [] }
    ],
    source: null,
    placement: 'local',
    accountCatalogue: [],
    commitSource: 'proposer',
    capabilities: { sameConversationRoute: false },
    ...overrides
  }
}

describe('proposeWorkPlan', () => {
  it('turns a described workflow into a valid WorkPlan and its sentence', async () => {
    const result = await proposeWorkPlan(
      {
        text: '3 researchers then synthesize, 3 planners, a judge picks, the winner improves, two reviewers, then me',
        ctx: ctx()
      },
      heuristicProposeWorkPlanDeps()
    )
    expect(result.plan).not.toBeNull()
    if (!result.plan) {
      throw new Error('expected a plan')
    }
    expect(result.plan.nodes.filter((node) => node.kind === 'worker' && node.role === 'research')).toHaveLength(3)
    expect(result.plan.nodes.filter((node) => node.kind === 'worker' && node.role === 'plan')).toHaveLength(3)
    const judge = result.plan.nodes.find((node) => node.kind === 'worker' && node.role === 'judge')
    expect(judge).toBeTruthy()
    const winner = result.plan.nodes.find(
      (node) => node.kind === 'worker' && node.readsWinnerOf === judge!.id
    )
    expect(winner).toBeTruthy()
    expect(result.plan.nodes.at(-1)).toMatchObject({ kind: 'finish', how: 'my-review' })
    expect(result.sentence).toBe(workPlanSentence(result.plan))
  })

  it('is deterministic: sentence -> plan -> sentence is stable on repeat proposals', async () => {
    const text = '3 researchers then synthesize, 3 planners, a judge picks, the winner improves, two reviewers, then me'
    const first = await proposeWorkPlan({ text, ctx: ctx() }, heuristicProposeWorkPlanDeps())
    const second = await proposeWorkPlan({ text, ctx: ctx() }, heuristicProposeWorkPlanDeps())
    if (!first.plan || !second.plan) {
      throw new Error('expected both proposals to produce a plan')
    }
    expect(workPlanSentence(first.plan)).toBe(workPlanSentence(second.plan))
  })

  it('returns no-pursuit for a question, never a banner-worthy plan', async () => {
    const result = await proposeWorkPlan(
      { text: 'What is the recommended next action after a Best-of-N judge?', ctx: ctx() },
      heuristicProposeWorkPlanDeps()
    )
    expect(result.plan).toBeNull()
    expect(result).toMatchObject({ reason: 'no-pursuit' })
  })

  it('returns no-pursuit for a discussion question about reviewers', async () => {
    const result = await proposeWorkPlan(
      { text: 'Does the reviewer get reviewed by the judge too?', ctx: ctx() },
      heuristicProposeWorkPlanDeps()
    )
    expect(result.plan).toBeNull()
    expect(result).toMatchObject({ reason: 'no-pursuit' })
  })

  it('refuses an actor this host cannot launch', async () => {
    const deps = {
      async parse(): Promise<WorkPlan> {
        return {
          outcome: { title: 'x', doneWhen: [], outputKind: 'work' },
          nodes: [
            {
              kind: 'worker',
              id: 'r1',
              role: 'research',
              actor: { agent: 'gemini' },
              instruction: 'research'
            },
            { kind: 'finish', id: 'f1', how: 'complete' }
          ]
        }
      }
    }
    const result = await proposeWorkPlan(
      { text: 'have a researcher look into this', ctx: ctx({ usableAgents: [{ agent: 'claude', models: [] }] }) },
      deps
    )
    expect(result.plan).toBeNull()
    expect(result).toMatchObject({ reason: 'unusable-agents' })
  })

  it('refuses a proposed condition.verification / command evidence (commitSource proposer)', async () => {
    const deps = {
      async parse(): Promise<WorkPlan> {
        return {
          outcome: {
            title: 'x',
            doneWhen: [
              {
                id: 'd1',
                text: 'tests pass',
                evidence: 'command',
                command: { program: 'npm', args: ['test'] }
              }
            ],
            outputKind: 'work'
          },
          nodes: [
            {
              kind: 'worker',
              id: 'r1',
              role: 'research',
              actor: { agent: 'claude' },
              instruction: 'research'
            },
            { kind: 'finish', id: 'f1', how: 'complete' }
          ]
        }
      }
    }
    const result = await proposeWorkPlan({ text: 'run a research step', ctx: ctx() }, deps)
    expect(result.plan).toBeNull()
    expect(result).toMatchObject({ reason: 'invalid' })
  })

  it('refuses a judge from the same family as its candidates', async () => {
    const deps = {
      async parse(): Promise<WorkPlan> {
        return {
          outcome: { title: 'x', doneWhen: [], outputKind: 'work' },
          nodes: [
            {
              kind: 'worker',
              id: 'p1',
              role: 'plan',
              actor: { agent: 'claude' },
              instruction: 'plan',
              group: 'g1'
            },
            {
              kind: 'worker',
              id: 'p2',
              role: 'plan',
              actor: { agent: 'claude' },
              instruction: 'plan',
              group: 'g1'
            },
            {
              kind: 'worker',
              id: 'j1',
              role: 'judge',
              actor: { agent: 'claude' },
              instruction: 'judge',
              readsFrom: ['p1', 'p2'],
              verdict: { kind: 'judge', over: ['p1', 'p2'], consumed: 'select-winner' }
            },
            { kind: 'finish', id: 'f1', how: 'complete' }
          ]
        }
      }
    }
    const result = await proposeWorkPlan({ text: '2 planners then a judge picks', ctx: ctx() }, deps)
    expect(result.plan).toBeNull()
    expect(result).toMatchObject({ reason: 'invalid' })
    expect(result.plan === null && result.problems?.some((p) => p.code === 'judge-family-collision')).toBe(true)
  })

  it('returns provider-unavailable when the parse call throws', async () => {
    const result = await proposeWorkPlan(
      {
        text: 'have 2 researchers look into this then me',
        ctx: ctx()
      },
      {
        async parse() {
          throw new Error('provider down')
        }
      }
    )
    expect(result.plan).toBeNull()
    expect(result).toMatchObject({ reason: 'provider-unavailable' })
  })
})
