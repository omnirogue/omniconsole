/**
 * A step entering `completedSteps` settles its own `status` in the same write. The outcome host
 * reads the set, but the panel, the sidebar count and the plan summary read `status`, and a stage
 * released from behind a review that ran and produced its output still said `queued` (live run
 * L7). Closing a step still skips it, and a handoff keeps what its own delivery wrote.
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain, SessionChainStep } from '../../shared/session-chain-types'
import { markSteps, type OutcomeStepAccess } from './session-outcome-step-progress'

const handoff = {
  id: 'ask',
  kind: 'handoff',
  status: 'delivered',
  handoff: { recipients: [] }
} as unknown as SessionChainStep

function chain(steps: SessionChainStep[]): SessionChain {
  return {
    id: 'chn_1',
    workspacePath: '/work',
    worktreeId: 'repo::wt',
    hostId: null,
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    error: null,
    createdAt: 1,
    updatedAt: 1,
    steps,
    outcomeSet: { completedSteps: [] } as unknown as SessionChain['outcomeSet']
  }
}

function access(initial: SessionChain): OutcomeStepAccess & { current: () => SessionChain } {
  let held = initial
  return {
    read: () => held,
    save: (next: SessionChain) => {
      held = next
    },
    current: () => held
  } as unknown as OutcomeStepAccess & { current: () => SessionChain }
}

const agent = (id: string, status: SessionChainStep['status']) =>
  ({ id, agent: 'claude', prompt: id, status }) as SessionChainStep

const statuses = (value: SessionChain) => value.steps.map((step) => [step.id, step.status])

describe('a step marked complete', () => {
  it('reads launched once it ran, and leaves the steps still to come alone', () => {
    const at = access(chain([agent('released', 'queued'), agent('next', 'queued')]))
    markSteps(at, ['released'])

    expect(at.current().outcomeSet!.completedSteps).toEqual(['released'])
    expect(statuses(at.current())).toEqual([
      ['released', 'launched'],
      ['next', 'queued']
    ])
    expect(at.current().currentIndex).toBe(1)
  })

  it('agrees with the set for a step whose earlier launch had failed', () => {
    const at = access(chain([agent('retried', 'failed')]))
    markSteps(at, ['retried'])
    expect(statuses(at.current())).toEqual([['retried', 'launched']])
  })

  it('still skips what it closes, and never un-skips a step closed before', () => {
    const at = access(chain([agent('loser', 'queued'), agent('closed', 'skipped')]))
    markSteps(at, ['loser'], true)
    markSteps(at, ['closed'])

    expect(statuses(at.current())).toEqual([
      ['loser', 'skipped'],
      ['closed', 'skipped']
    ])
    expect(at.current().outcomeSet!.completedSteps).toEqual(['loser', 'closed'])
  })

  it('keeps the status a handoff delivery wrote', () => {
    const at = access(chain([handoff, agent('after', 'queued')]))
    markSteps(at, ['ask'])
    markSteps(at, ['ask'], true)
    expect(statuses(at.current())).toEqual([
      ['ask', 'delivered'],
      ['after', 'queued']
    ])
  })
})
