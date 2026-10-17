// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkPlanQuestions } from './WorkPlanQuestions'
import { fixtureChain, context, subject } from './work-plan-test-fixtures'
import { commitWorkPlan, type WorkPlanCommitRequest } from '../../../../../shared/work-plan-commit'
import { sessionOutcomeConditionKey } from '../../../../../shared/session-outcome-types'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { workPlanNotation } from '../../../../../shared/work-plan-notation'
import { anchorWorkPlan } from './work-plan-state-from-chain'
import { proposeNextWorkPlan } from './propose-next-work-plan'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, values?: Record<string, unknown>) =>
    text.replace(/{{(\w+)}}/g, (_, key: string) => String(values?.[key] ?? ''))
}))
afterEach(cleanup)
function mount(chain: SessionChain | null = fixtureChain()) {
  const commit = vi.fn(async (request: WorkPlanCommitRequest) => request.chain)
  const onSend = vi.fn(async (plan, changeStrategy) =>
    commitWorkPlan(plan, {
      ...context,
      chain: chain ?? fixtureChain(),
      ...(changeStrategy ? { existingChain: chain! } : {}),
      commitSessionOutcomes: commit
    })
  )
  const view = render(
    <WorkPlanQuestions
      chain={chain}
      subject={subject}
      ctx={context}
      onSend={onSend}
      onWhere={vi.fn()}
    />
  )
  return { ...view, commit, onSend }
}
const recommended = () =>
  [...document.querySelectorAll('[data-work-plan-recommendations] [role="menuitem"]')].map(
    (el) => el.textContent
  )
const notation = () => document.querySelector('[data-work-plan-notation]')?.textContent
function verdict(chain: SessionChain, status: string) {
  chain.verdicts = [
    {
      stepId: chain.steps.at(-1)!.id,
      attemptId: 'attempt',
      verdict: { status },
      consumptionKey: 'key',
      consumedAt: 1
    }
  ]
}
it.each([
  [
    'implement',
    1,
    [
      '✓ Verify against Outcome',
      '👀 Review',
      '🧪 Test',
      '🔬 Analyze gaps',
      '✨ Improve',
      '📝 Plan remaining work'
    ]
  ],
  ['research', 1, ['📝 Plan', '→ Give to…']],
  ['research', 3, ['◇ Synthesize', '📝 Plan', '→ Give to…']],
  ['plan', 1, ['👀 Review plan', '🛠 Implement', '→ Give to…']],
  ['plan', 3, ['⚖ Judge', '◇ Synthesize', '👀 Review']]
] as const)('renders the live %s/%s family', (role, count, expected) => {
  mount(fixtureChain(role, count))
  expect(recommended()).toEqual(expected)
})
it.each(['findings', 'fail'])('offers repair and verify for %s', (status) => {
  const chain = fixtureChain('review')
  verdict(chain, status)
  chain.outcomeSet!.attempts = [
    {
      id: 'retry',
      actionId: 'action',
      actionKey: 'key',
      outcomeId: chain.outcomeSet!.outcomes[0]!.id,
      outcomeRevision: 1,
      state: 'retryable',
      startedAt: 1,
      updatedAt: 1
    }
  ]
  mount(chain)
  expect(recommended()).toEqual(['✨ Improve (repair)', '✓ Verify'])
})
it('only recommends Done with current evidence', () => {
  const chain = fixtureChain('verify')
  verdict(chain, 'pass')
  const outcome = chain.outcomeSet!.outcomes[0]!
  const condition = outcome.conditions[0]!
  outcome.evidence = [
    {
      id: 'e',
      outcomeId: outcome.id,
      outcomeRevision: outcome.revision,
      conditionId: condition.id,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      receipt: 'receipt',
      verifiedAt: 1,
      verifier: 'execution-host'
    }
  ]
  mount(chain)
  expect(recommended()).toEqual(['Done (👤 Me)'])
})
it('hides invalid fragments instead of disabling them', () => {
  mount(fixtureChain())
  expect(screen.queryByRole('menuitem', { name: 'Judge', hidden: true })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Synthesize', hidden: true })).toBeNull()
})
it('builds a chainless first fragment directly and keeps first render and every edit authoritative', async () => {
  const view = mount(null)
  expect(notation()).toBe('Research → 👤')
  fireEvent.click(screen.getByRole('button', { name: 'HOW · 1 agent' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Council' }))
  expect(screen.getByRole('button', { name: 'HOW · Council' })).toBeTruthy()
  expect(notation()).toContain('⑂3 Research → ⑂3 Critique → ⚖')
  fireEvent.click(screen.getByText('All actions'))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Improve' }))
  expect(notation()).toBe('✨ → 👤')
  fireEvent.click(screen.getByRole('button', { name: 'WHERE · Continue workflow' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Me' }))
  expect(screen.getByRole('button', { name: 'WHERE · Me' })).toBeTruthy()
  expect(notation()).toBe('✨ → 👤')
  fireEvent.click(screen.getByRole('menuitem', { name: '🤖 Agent' }))
  expect(screen.getByRole('button', { name: 'WHERE · 🤖 Agent' })).toBeTruthy()
  expect(notation()).toBe('✨ → 👤')
  await act(async () => screen.getByRole('button', { name: 'Send' }).click())
  expect(workPlanNotation(view.onSend.mock.calls[0]![0])).toBe(notation())
})
it('defaults Change strategy, prefills evidence gaps, and commits v2 with supersede', async () => {
  const chain = fixtureChain()
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = 'Missing price'
  const view = mount(chain)
  expect(recommended()[0]).toBe('⟲ Change strategy')
  expect(document.querySelector('[data-work-plan-selection]')?.textContent).toBe(
    '⟲ Change strategy'
  )
  expect(
    (screen.getByRole('textbox', { name: 'Next instruction' }) as HTMLTextAreaElement).value
  ).toContain('Missing price. Unsatisfied Done When: The page shows the price')
  expect(notation()).toBe('Implement → 📝 → 👤')
  await act(async () => screen.getByRole('button', { name: 'Send' }).click())
  expect(view.commit).toHaveBeenCalledOnce()
  expect(view.commit.mock.calls[0]![0]).toMatchObject({
    chain: { planVersion: 2 },
    supersede: { reason: 'Missing price' }
  })
})
it.each(['launching', 'running', 'unverifiable'] as const)(
  'hides Change strategy during %s',
  (state) => {
    const chain = fixtureChain()
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.attempts = [
      {
        id: 'a',
        actionId: 'a',
        actionKey: 'key',
        outcomeId: chain.outcomeSet!.outcomes[0]!.id,
        outcomeRevision: 1,
        state,
        startedAt: 1,
        updatedAt: 1
      }
    ]
    mount(chain)
    expect(screen.queryByRole('menuitem', { name: /Change strategy/ })).toBeNull()
  }
)
it('uses the fragment availability result for the same proposed notation', () => {
  const anchor = anchorWorkPlan(fixtureChain(), subject)
  const result = proposeNextWorkPlan(
    anchor.plan,
    anchor.anchorNodeId,
    { action: 'improve', topology: 'solo', route: 'human', actor: { agent: 'codex' } },
    context
  )
  expect('plan' in result && workPlanNotation(result.plan)).toBe('Implement → ✨ → 👤')
})
it('keeps commit problems in the panel and never reports success', async () => {
  const view = mount()
  view.commit.mockRejectedValueOnce(new Error('The execution host refused the plan.'))
  await act(async () => screen.getByRole('button', { name: 'Send' }).click())
  expect(screen.getByRole('alert').textContent).toContain('The execution host refused the plan.')
  expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
})
it('updates recommendations synchronously when the live outcome becomes blocked', () => {
  const view = mount()
  const chain = fixtureChain()
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = 'No evidence'
  view.rerender(
    <WorkPlanQuestions
      chain={chain}
      subject={subject}
      ctx={context}
      onSend={view.onSend}
      onWhere={vi.fn()}
    />
  )
  expect(recommended()[0]).toBe('⟲ Change strategy')
  expect(notation()).toBe('Implement → 📝 → 👤')
})
it('hides plan-only fragments refused by the shared validator', () => {
  const chain = fixtureChain('plan')
  chain.outcomeSet!.outcomes[0]!.outputKind = 'plan'
  mount(chain)
  // appendWorkPlanFragment currently inherits workspace writes from its work-shaped seed.
  expect(recommended()).toEqual([])
  expect(screen.getByText('No available next step for this plan and execution host.')).toBeTruthy()
})
it('a fail without retry offers Change strategy first', () => {
  const chain = fixtureChain('verify')
  verdict(chain, 'fail')
  mount(chain)
  expect(recommended()[0]).toBe('⟲ Change strategy')
})
