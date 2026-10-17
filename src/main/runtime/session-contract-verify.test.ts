import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workPlanBlocks, workPlanProblems } from '../../shared/work-plan-validate'
import { workPlanFixtureContext } from '../../shared/__fixtures__/work-plan/work-plan-context'
import type { OrcaRuntimeService } from './omni-runtime'
import { mergeUsableAgents } from './up-next-plan-actors'

const upNext = vi.hoisted(() => ({
  chainFor: vi.fn(),
  baseChain: vi.fn(),
  commitPlan: vi.fn()
}))
vi.mock('./up-next', () => ({ upNextChainFor: upNext.chainFor }))
vi.mock('./up-next-commit', () => ({ upNextBaseChain: upNext.baseChain }))
vi.mock('./up-next-plan-edit', () => ({ upNextCommitPlan: upNext.commitPlan }))

const { attachContractVerify, contractVerifyPlan } = await import('./session-contract-verify')

const REQUEST = {
  worktreeId: 'repo::/work/feature',
  paneKey: 'tab-1:pane-1',
  title: 'Login fix',
  doneWhen: ['pnpm test login exits 0', 'the timeout is 30 seconds in config/auth.ts'],
  agent: 'claude' as const
}

function runtimeWith(states: (string | null)[], continuation = true): OrcaRuntimeService {
  let at = 0
  return {
    resolveTerminalPane: () => ({ handle: 'term_1' }),
    getFreshAgentHookStatusForHandle: () => {
      const state = states[Math.min(at++, states.length - 1)]
      return state === 'boundary'
        ? { state: 'done', sessionBoundary: true }
        : state
          ? { state }
          : null
    },
    hasSessionOutcomeContinuation: () => continuation
  } as unknown as OrcaRuntimeService
}

function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    }
  }
}

beforeEach(() => {
  upNext.chainFor.mockReset().mockReturnValue(null)
  upNext.baseChain.mockReset().mockResolvedValue({ id: 'chain' })
  upNext.commitPlan.mockReset().mockResolvedValue('chain')
})

describe('the verify plan a prepared session carries', () => {
  it('passes the work-plan validator, with one gate and no unverified repair', () => {
    const ctx = workPlanFixtureContext({
      // The same merge the Up next commit builds its catalogue with.
      usableAgents: mergeUsableAgents([
        [{ agent: 'claude', models: [] }],
        [{ agent: 'claude', models: [{ id: 'sonnet', label: 'sonnet', efforts: ['medium'] }] }]
      ])
    })
    const plan = contractVerifyPlan(REQUEST)
    expect(workPlanBlocks(workPlanProblems(plan, ctx))).toEqual([])
    expect(plan.outcome.doneWhen.map((entry) => entry.id)).toEqual(['DW1', 'DW2'])
    expect(plan.nodes[0]).toMatchObject({
      role: 'verify',
      actor: { agent: 'claude', model: 'sonnet' },
      verdict: { kind: 'verify', over: ['DW1', 'DW2'], consumed: 'gate' }
    })
    expect(plan.nodes.map((node) => node.id)).toEqual(['verify', 'finish'])
    expect(contractVerifyPlan({ ...REQUEST, label: 'A' }).outcome.doneWhen[0]!.id).toBe('A1')
  })
})

describe('attaching it to a launched session', () => {
  it('waits for the first turn, then commits the plan with the cheaper verify seat', async () => {
    const result = await attachContractVerify(
      runtimeWith([null, 'boundary', 'working']),
      REQUEST,
      fakeClock()
    )
    expect(result).toEqual({ attached: true })
    expect(upNext.commitPlan).toHaveBeenCalledTimes(1)
    const [ctx, plan] = upNext.commitPlan.mock.calls[0]!
    expect(ctx).toMatchObject({ agent: 'claude', existing: null })
    expect(plan.nodes.map((node: { id: string }) => node.id)).toEqual(['verify', 'finish'])
  })

  it('never commits before the session starts working, and says so', async () => {
    const result = await attachContractVerify(runtimeWith(['boundary']), REQUEST, fakeClock())
    expect(result).toEqual({
      attached: false,
      reason: 'the session did not start its first turn within 3 minutes',
      retryable: true
    })
    expect(upNext.commitPlan).not.toHaveBeenCalled()
  })

  it('leaves a plan someone already composed alone', async () => {
    upNext.chainFor.mockReturnValue({ id: 'theirs' })
    const result = await attachContractVerify(runtimeWith(['working']), REQUEST, fakeClock())
    expect(result).toEqual({ attached: false, reason: 'the conversation already has a plan' })
    expect(upNext.commitPlan).not.toHaveBeenCalled()
  })
})
