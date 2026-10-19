import { describe, expect, it } from 'vitest'
import {
  SESSION_ACTION_OUTCOME_INSTRUCTIONS,
  SESSION_ACTION_PRESET_INSTRUCTIONS
} from './session-action-presets'
import { workPlanProblems } from './work-plan-validate'
import {
  workPlanOutcomeOf,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanNode
} from './work-plan-types'
import { councilWorkPlan } from './__fixtures__/work-plan/council-work-plan'
import { outcomeGateWorkPlan } from './__fixtures__/work-plan/outcome-gate-work-plan'
import { samWorkPlan } from './__fixtures__/work-plan/sal-work-plan'
import {
  WORK_PLAN_FIXTURE_ACTORS,
  workPlanFixtureContext
} from './__fixtures__/work-plan/work-plan-context'

const { claude, codex, grok, kimi, gemini } = WORK_PLAN_FIXTURE_ACTORS

function basePlan(): WorkPlan {
  return {
    outcome: {
      title: 'Fix the checkout',
      outputKind: 'work',
      doneWhen: [
        { id: 'dw-checkout', text: 'the checkout completes a test order', evidence: 'report' }
      ]
    },
    nodes: [
      { kind: 'worker', id: 'draft', role: 'implement', instruction: '', actor: claude },
      {
        kind: 'worker',
        id: 'check',
        role: 'verify',
        instruction: '',
        actor: codex,
        readsFrom: ['draft'],
        verdict: { kind: 'verify', over: ['dw-checkout'], consumed: 'gate' }
      },
      { kind: 'finish', id: 'me', how: 'my-review', route: 'human' }
    ]
  }
}

function withNodes(nodes: WorkPlanNode[], plan = basePlan()): WorkPlan {
  return { ...plan, nodes }
}

function withOutputKind(plan: WorkPlan, outputKind: 'work' | 'plan' | 'mockup'): WorkPlan {
  return { ...plan, outcome: { ...plan.outcome, outputKind } }
}

function withDoneWhen(plan: WorkPlan, doneWhen: WorkPlan['outcome']['doneWhen']): WorkPlan {
  return { ...plan, outcome: { ...plan.outcome, doneWhen } }
}

function codes(plan: WorkPlan, ctx: WorkPlanContext = workPlanFixtureContext()): string[] {
  return workPlanProblems(plan, ctx).map((problem) => problem.code)
}

function node(plan: WorkPlan, id: string): WorkPlanNode {
  return plan.nodes.find((entry) => entry.id === id)!
}

function replace(plan: WorkPlan, id: string, patch: Record<string, unknown>): WorkPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((entry) =>
      entry.id === id ? ({ ...entry, ...patch } as WorkPlanNode) : entry
    )
  }
}

describe('the one work-plan validator', () => {
  it('passes a plain plan, and passes both shipped fixtures with no blocks and no warnings', () => {
    expect(workPlanProblems(basePlan(), workPlanFixtureContext())).toEqual([])
    expect(workPlanProblems(samWorkPlan(), workPlanFixtureContext())).toEqual([])
    expect(workPlanProblems(councilWorkPlan(), workPlanFixtureContext())).toEqual([])
    expect(workPlanProblems(outcomeGateWorkPlan(), workPlanFixtureContext())).toEqual([])
    const plan = basePlan()
    const attached: WorkPlan = {
      ...plan,
      outcome: { ...plan.outcome, taskRef: 'btk_9fA2', outcomeId: 'ship', revision: 2 }
    }
    expect(workPlanProblems(attached, workPlanFixtureContext())).toEqual([])
  })

  describe('structure', () => {
    it('refuses an empty plan and says nothing else', () => {
      expect(codes(withNodes([]))).toEqual(['plan-no-nodes'])
    })

    it('refuses two steps with one name', () => {
      const plan = basePlan()
      expect(codes(withNodes([...plan.nodes, { ...node(plan, 'draft') }]))).toContain(
        'plan-duplicate-node-id'
      )
    })

    it('refuses a plan with no finish, two finishes, or a finish that is not last', () => {
      const plan = basePlan()
      expect(codes(withNodes(plan.nodes.slice(0, 2)))).toContain('plan-no-finish')
      expect(codes(withNodes([...plan.nodes, node(plan, 'me')]))).toContain('plan-multiple-finish')
      expect(
        codes(withNodes([node(plan, 'draft'), node(plan, 'me'), node(plan, 'check')]))
      ).toContain('plan-finish-not-last')
    })
  })

  describe('roles compile to a prompt', () => {
    it('refuses a role this build cannot run', () => {
      expect(codes(replace(basePlan(), 'draft', { role: 'teleport' }))).toContain(
        'role-preset-missing'
      )
    })

    it('refuses a role whose preset has no default instruction', () => {
      const plain = SESSION_ACTION_PRESET_INSTRUCTIONS as Record<string, string>
      const relative = SESSION_ACTION_OUTCOME_INSTRUCTIONS as Record<string, string | undefined>
      const originals = { plain: plain.implement, relative: relative.implement }
      plain.implement = '   '
      relative.implement = '  '
      try {
        expect(codes(basePlan())).toContain('role-preset-empty-instruction')
      } finally {
        plain.implement = originals.plain
        relative.implement = originals.relative
      }
    })
  })

  describe('route', () => {
    it('refuses a route this build does not know', () => {
      expect(codes(replace(basePlan(), 'draft', { route: 'telepathy' }))).toContain('route-unknown')
    })

    it('keeps the person at the finish', () => {
      expect(codes(replace(basePlan(), 'draft', { route: 'human' }))).toContain(
        'route-human-not-finish'
      )
      expect(codes(replace(basePlan(), 'me', { route: 'new-session' }))).toContain(
        'route-finish-not-human'
      )
    })

    it('refuses same-session until the host reports the route', () => {
      expect(codes(replace(basePlan(), 'draft', { route: 'same-session' }))).toContain(
        'route-same-session-unsupported'
      )
    })

    it('refuses same-session with no conversation to continue', () => {
      const ctx = workPlanFixtureContext({
        capabilities: { sameConversationRoute: true },
        source: null
      })
      expect(codes(replace(basePlan(), 'draft', { route: 'same-session' }), ctx)).toContain(
        'route-same-session-needs-source'
      )
    })

    it('refuses same-session on anything but one seat', () => {
      const ctx = workPlanFixtureContext({ capabilities: { sameConversationRoute: true } })
      const plan = replace(basePlan(), 'draft', {
        route: 'same-session',
        count: 2,
        seats: [claude, codex],
        writes: 'own-output-dir'
      })
      expect(codes(plan, ctx)).toContain('route-same-session-not-solo')
    })

    it('refuses an actor override on a continued node: the conversation answers it', () => {
      const ctx = workPlanFixtureContext({ capabilities: { sameConversationRoute: true } })
      // The source conversation is claude/opus-4; this asks codex to answer inside it.
      const plan = replace(basePlan(), 'draft', { route: 'same-session', actor: codex })
      expect(codes(plan, ctx)).toContain('route-same-session-actor-override')
      const kept = replace(basePlan(), 'draft', { route: 'same-session', actor: claude })
      expect(codes(kept, ctx)).not.toContain('route-same-session-actor-override')
    })

    it('refuses same-session on a card-bound plan, which continues its own worker', () => {
      const ctx = workPlanFixtureContext({
        capabilities: { sameConversationRoute: true },
        placement: 'card'
      })
      expect(codes(replace(basePlan(), 'draft', { route: 'same-session' }), ctx)).toContain(
        'route-same-session-card-bound'
      )
    })

    it('accepts one continued seat on a local plan the host advertises the route for', () => {
      const ctx = workPlanFixtureContext({ capabilities: { sameConversationRoute: true } })
      expect(codes(replace(basePlan(), 'draft', { route: 'same-session' }), ctx)).toEqual([])
    })
  })

  describe('seats that run side by side', () => {
    it('refuses parallel seats writing one workspace and names the missing capability', () => {
      const plan = replace(basePlan(), 'draft', {
        count: 2,
        seats: [claude, codex],
        writes: 'workspace'
      })
      const problem = workPlanProblems(plan, workPlanFixtureContext()).find(
        (entry) => entry.code === 'parallel-writes-workspace'
      )
      expect(problem?.message).toContain('Per-seat worktrees do not exist yet')
    })

    it('refuses a parallel writer that does not say where it writes', () => {
      expect(codes(replace(basePlan(), 'draft', { count: 2, seats: [claude, codex] }))).toContain(
        'parallel-writes-undeclared'
      )
    })

    it('allows parallel read-and-report seats with nothing declared', () => {
      expect(
        codes(replace(basePlan(), 'draft', { role: 'research', count: 2, seats: [claude, codex] }))
      ).toEqual([])
    })

    it('refuses a broken seat count and a seat list that does not match it', () => {
      expect(codes(replace(basePlan(), 'draft', { count: 0 }))).toContain('count-invalid')
      expect(
        codes(replace(basePlan(), 'draft', { role: 'research', count: 3, seats: [claude, codex] }))
      ).toContain('seats-count-mismatch')
    })

    it('shows a repeated seat actor as a warning, never hides it and never blocks', () => {
      const problems = workPlanProblems(
        replace(basePlan(), 'draft', {
          role: 'research',
          count: 2,
          seats: [claude, claude]
        }),
        workPlanFixtureContext()
      )
      expect(problems.map((problem) => problem.code)).toEqual(['actor-duplicate-seat'])
      expect(problems[0]!.severity).toBe('warn')
    })
  })

  describe('reading edges', () => {
    it('refuses reading a step that is not in the plan or does not run first', () => {
      expect(codes(replace(basePlan(), 'check', { readsFrom: ['ghost'] }))).toContain(
        'reads-from-unknown'
      )
      expect(codes(replace(basePlan(), 'draft', { readsFrom: ['check'] }))).toContain(
        'reads-from-not-earlier'
      )
    })

    it('refuses reading its own output, so a plan can never cycle', () => {
      expect(codes(replace(basePlan(), 'draft', { readsFrom: ['draft'] }))).toContain(
        'reads-from-not-earlier'
      )
    })

    it('refuses a winner read from a step that picks no winner', () => {
      const plan = samWorkPlan()
      expect(codes(replace(plan, 'improve', { readsWinnerOf: 'ghost' }))).toContain(
        'reads-winner-of-unknown'
      )
      expect(codes(replace(plan, 'improve', { readsWinnerOf: 'verify' }))).toContain(
        'reads-winner-of-not-earlier'
      )
      expect(codes(replace(plan, 'improve', { readsWinnerOf: 'synthesis' }))).toContain(
        'reads-winner-of-not-select-winner'
      )
    })
  })

  describe('verdicts are spent', () => {
    it('refuses a verdict over nothing, over a stranger, or over work it never read', () => {
      expect(
        codes(
          replace(basePlan(), 'check', { verdict: { kind: 'verify', over: [], consumed: 'gate' } })
        )
      ).toContain('verdict-over-empty')
      const judged = samWorkPlan()
      expect(
        codes(
          replace(judged, 'plan-judge', {
            verdict: { kind: 'judge', over: ['ghost'], consumed: 'select-winner' }
          })
        )
      ).toContain('verdict-over-unknown')
      expect(
        codes(
          replace(judged, 'plan-judge', {
            verdict: { kind: 'judge', over: ['synthesis'], consumed: 'select-winner' }
          })
        )
      ).toContain('verdict-over-not-read')
    })

    it('refuses a judge nobody reads and a critique nobody reads', () => {
      const judged = replace(samWorkPlan(), 'improve', { readsWinnerOf: undefined })
      expect(codes(judged)).toContain('verdict-unconsumed')
      const council = councilWorkPlan()
      expect(
        codes(
          replace(council, 'council-judge', { readsFrom: ['answer-a', 'answer-b', 'answer-c'] })
        )
      ).toContain('verdict-unconsumed')
    })

    it('refuses a gate with nothing after it', () => {
      const plan = basePlan()
      expect(codes(withNodes([node(plan, 'draft'), node(plan, 'check')]))).toContain(
        'verdict-unconsumed'
      )
    })

    it('accepts a winner taken by a gated group instead of a reader', () => {
      const plan = replace(samWorkPlan(), 'improve', {
        readsWinnerOf: undefined,
        enabledBy: { verdict: 'plan-judge', seatsOf: 'plan' }
      })
      expect(codes(plan)).toEqual([])
    })
  })

  describe('the outcome above the chain', () => {
    it('passes the outcome-gate fixture: build, check against done-when, repair', () => {
      expect(workPlanProblems(outcomeGateWorkPlan(), workPlanFixtureContext())).toEqual([])
    })

    it('needs no Task, and refuses a card name this board cannot hold', () => {
      const plan = basePlan()
      // A standalone session pursues an outcome with no Task at all.
      expect(workPlanOutcomeOf(plan).taskRef).toBeUndefined()
      expect(codes(plan)).toEqual([])
      expect(codes({ ...plan, outcome: { ...plan.outcome, taskRef: 'btk_9fA2' } })).toEqual([])
      expect(codes({ ...plan, outcome: { ...plan.outcome, taskRef: 'task-7' } })).toContain(
        'outcome-task-ref-invalid'
      )
    })

    it('takes a check the host can run, and only from the person', () => {
      const plan = basePlan()
      const checked = withDoneWhen(plan, [
        {
          id: 'dw-checkout',
          text: 'the checkout check passes',
          evidence: 'command',
          command: { program: 'npm', args: ['run', 'check'], expectedStdout: 'PASS' }
        }
      ])
      expect(codes(checked)).toEqual([])
      expect(
        codes(withDoneWhen(plan, [{ id: 'dw-checkout', text: 'it passes', evidence: 'command' }]))
      ).toContain('outcome-done-when-no-command')
      // F7: the host executes this, so a plan the person did not write may not carry one.
      for (const commitSource of ['ai', 'library', 'proposer'] as const) {
        expect(codes(checked, workPlanFixtureContext({ commitSource }))).toContain(
          'outcome-command-not-user'
        )
      }
      expect(codes(checked, workPlanFixtureContext({ commitSource: 'user' }))).toEqual([])
    })

    it('refuses a second outcome anywhere in the plan', () => {
      const plan = basePlan()
      // Why the cast: the type forbids it, so only a plan parsed from JSON -- the proposer, a
      // saved layout, a hand-edited file -- can carry a second outcome, which is what this refuses.
      const nested = plan.nodes.map((node) =>
        node.id === 'draft'
          ? ({ ...node, doneWhen: [{ id: 'x', text: 'y' }] } as unknown as WorkPlanNode)
          : node
      )
      expect(codes(withNodes(nested))).toContain('plan-second-outcome')
    })

    it('needs a name and a usable done-when list', () => {
      const plan = basePlan()
      expect(codes({ ...plan, outcome: { ...plan.outcome, title: ' ' } })).toContain(
        'outcome-no-title'
      )
      expect(
        codes(
          withDoneWhen(plan, [
            { id: 'dw', text: 'a', evidence: 'report' },
            { id: 'dw', text: 'b', evidence: 'report' }
          ])
        )
      ).toContain('outcome-done-when-duplicate-id')
      expect(codes(withDoneWhen(plan, [{ id: 'dw', text: ' ', evidence: 'report' }]))).toContain(
        'outcome-done-when-no-text'
      )
      expect(codes(withDoneWhen(plan, [{ id: 'dw', text: 'a', evidence: 'file' }]))).toContain(
        'outcome-done-when-no-path'
      )
    })

    it('lets a person be the done-when, and refuses a plan that finishes with neither', () => {
      const plan = withDoneWhen(basePlan(), [])
      expect(codes(plan)).not.toContain('outcome-done-when-empty')
      expect(codes(replace(plan, 'me', { how: 'complete', route: undefined }))).toContain(
        'outcome-done-when-empty'
      )
    })

    it('measures a verify step against the outcome, never against another step', () => {
      const plan = basePlan()
      expect(
        codes(
          replace(plan, 'check', { verdict: { kind: 'verify', over: ['draft'], consumed: 'gate' } })
        )
      ).toContain('verify-over-done-when')
      expect(
        codes(
          replace(plan, 'check', {
            verdict: { kind: 'verify', over: ['dw-checkout'], consumed: 'record' }
          })
        )
      ).toContain('verify-verdict-not-gate')
    })

    it('sends a failed gate to a repair step, or lets it block the outcome', () => {
      const plan = outcomeGateWorkPlan()
      expect(codes(replace(plan, 'gate', { onFail: undefined }))).toEqual([])
      expect(codes(replace(plan, 'gate', { onFail: 'ghost' }))).toContain(
        'verify-fail-route-unknown'
      )
      expect(codes(replace(plan, 'gate', { onFail: 'build' }))).toContain(
        'verify-fail-route-not-repair'
      )
      expect(codes(replace(plan, 'fix', { onFail: 'fix' }))).toContain('fail-route-not-gate')
    })

    it('refuses seats planning side by side with nothing to aim at', () => {
      const plan = withDoneWhen(
        replace(basePlan(), 'draft', { role: 'plan', count: 2, seats: [claude, codex] }),
        []
      )
      expect(codes(plan)).toContain('parallel-plan-needs-outcome')
      // Its own instruction, or a stated end, is enough.
      expect(codes(replace(plan, 'draft', { instruction: 'Plan the two options.' }))).not.toContain(
        'parallel-plan-needs-outcome'
      )
      expect(codes(withDoneWhen(plan, basePlan().outcome.doneWhen))).not.toContain(
        'parallel-plan-needs-outcome'
      )
    })
  })

  describe('grouping', () => {
    it('refuses a deciding step that runs side by side or shares a group', () => {
      expect(codes(replace(basePlan(), 'check', { count: 2, seats: [codex, grok] }))).toContain(
        'verdict-node-parallel'
      )
      expect(codes(replace(basePlan(), 'check', { group: 'work' }))).toContain(
        'verdict-node-in-group'
      )
    })

    it("keeps a council's parallel critiques legal, because a record verdict decides nothing", () => {
      expect(codes(councilWorkPlan())).toEqual([])
    })

    it('refuses a gate that names a stranger, a step that picks no winner, or its own group', () => {
      const plan = samWorkPlan()
      expect(
        codes(replace(plan, 'improve', { enabledBy: { verdict: 'ghost', seatsOf: 'plan' } }))
      ).toContain('enabled-by-unknown-verdict')
      expect(
        codes(replace(plan, 'improve', { enabledBy: { verdict: 'synthesis', seatsOf: 'plan' } }))
      ).toContain('enabled-by-not-select-winner')
      expect(
        codes(replace(plan, 'improve', { enabledBy: { verdict: 'plan-judge', seatsOf: 'ghost' } }))
      ).toContain('enabled-by-unknown-seats')
      expect(
        codes(
          replace(plan, 'improve', { enabledBy: { verdict: 'plan-judge', seatsOf: 'synthesis' } })
        )
      ).toContain('enabled-by-seats-not-parallel')
    })

    it('refuses a step gated by a verdict inside its own group', () => {
      const council = councilWorkPlan()
      const gated = replace(
        replace(council, 'critique-a', {
          verdict: { kind: 'judge', over: ['answer-b'], consumed: 'select-winner' }
        }),
        'critique-b',
        { enabledBy: { verdict: 'critique-a', seatsOf: 'critique-a' } }
      )
      expect(codes(gated)).toContain('enabled-by-shares-group')
    })
  })

  describe('who decides', () => {
    it('never lets Gemini issue a verdict', () => {
      expect(codes(replace(basePlan(), 'check', { actor: gemini }))).toContain(
        'verdict-actor-refused'
      )
    })

    it('refuses a judge from a candidate family when another family is available', () => {
      expect(codes(replace(samWorkPlan(), 'plan-judge', { actor: claude }))).toContain(
        'judge-family-collision'
      )
    })

    it('says how many agents the host has when no judge can be independent', () => {
      const ctx = workPlanFixtureContext({
        usableAgents: [
          { agent: 'claude', models: [{ id: 'opus-4', label: 'o', efforts: ['high'] }] }
        ]
      })
      const plan = replace(replace(samWorkPlan(), 'plan-judge', { actor: claude }), 'plan', {
        count: 1,
        seats: [claude]
      })
      const problem = workPlanProblems(plan, ctx).find(
        (entry) => entry.code === 'judge-family-unavailable'
      )
      expect(problem?.message).toBe(
        'Best-of-N needs a judge from a different model family; you have 1 usable agents'
      )
    })

    it('refuses an actor this host cannot launch', () => {
      expect(
        codes(replace(basePlan(), 'draft', { actor: { agent: 'claude', model: 'sonnet-9' } }))
      ).toContain('actor-not-usable')
    })

    it('says nothing about actors when the host has not probed any', () => {
      const ctx = workPlanFixtureContext({ usableAgents: [] })
      expect(
        codes(replace(basePlan(), 'draft', { actor: { agent: 'claude', model: 'x' } }), ctx)
      ).toEqual([])
    })
  })

  describe('review rounds', () => {
    it('refuses rounds outside one to five, too many reviewers, and a review of nothing', () => {
      const plan = samWorkPlan()
      expect(codes(replace(plan, 'verify', { maxRounds: 6 }))).toContain(
        'review-rounds-out-of-range'
      )
      expect(
        codes(replace(plan, 'verify', { seats: [codex, grok, kimi, codex, grok, kimi] }))
      ).toContain('review-too-many-reviewers')
      expect(codes(replace(plan, 'verify', { readsFrom: [] }))).toContain('review-reads-nothing')
    })

    it('speaks the hub loop vocabulary and refuses anything outside it', () => {
      const plan = samWorkPlan()
      expect(codes(replace(plan, 'verify', { loop: 'adversarial' }))).toEqual([])
      expect(codes(replace(plan, 'verify', { loop: 'consensus' }))).toContain('review-kind-unknown')
      expect(codes(replace(plan, 'verify', { stop: 'all_gaps_closed' }))).toEqual([])
      expect(codes(replace(plan, 'verify', { stop: 'pass' }))).toContain('review-stop-unknown')
    })
  })

  describe('plan mode', () => {
    it('refuses a building role, a workspace write and a Go gate in a plan-only run', () => {
      const plan = withOutputKind(basePlan(), 'plan')
      const problems = codes(plan)
      expect(problems).toContain('output-kind-role')
      expect(problems).toContain('output-kind-finish-gate')
      expect(codes(withOutputKind(plan, 'mockup'))).toContain('output-kind-role')
      const writing = replace(plan, 'draft', {
        role: 'plan',
        writes: 'workspace'
      })
      expect(codes(writing)).toContain('output-kind-writes-workspace')
    })

    it('accepts a planning chain that finishes on its own', () => {
      const plan = replace(withOutputKind(basePlan(), 'plan'), 'draft', { role: 'plan' })
      expect(codes(replace(plan, 'me', { how: 'complete', route: undefined }))).toEqual([])
    })
  })

  describe('caps', () => {
    const wide = (count: number): WorkPlan =>
      replace(basePlan(), 'draft', { role: 'research', count, seats: undefined })

    it('counts stages, folding seats that run side by side into one', () => {
      const stages: WorkPlanNode[] = Array.from({ length: 7 }, (_, index) => ({
        kind: 'worker',
        id: `stage-${index}`,
        role: 'research',
        instruction: '',
        actor: claude
      }))
      expect(
        codes(withNodes([...stages, { kind: 'finish', id: 'me', how: 'complete' }]))
      ).toContain('stages-over-cap')
      const folded: WorkPlanNode[] = stages.map(
        (entry) => ({ ...entry, group: 'one' }) as WorkPlanNode
      )
      expect(
        codes(withNodes([...folded, { kind: 'finish', id: 'me', how: 'complete' }]))
      ).not.toContain('stages-over-cap')
    })

    it('guards the width the stage cap cannot see', () => {
      // The check step is the 24th seat, so 24 research seats is one too many.
      expect(codes(wide(24))).toContain('seats-over-cap')
      expect(codes(wide(23))).not.toContain('seats-over-cap')
    })

    it('holds an agent-authored plan to the narrower team budget', () => {
      const ctx = workPlanFixtureContext({ commitSource: 'ai' })
      expect(codes(wide(8), ctx)).toContain('ai-seats-over-cap')
      expect(codes(wide(7), ctx)).not.toContain('ai-seats-over-cap')
      expect(codes(wide(8))).not.toContain('ai-seats-over-cap')
    })
  })
})
