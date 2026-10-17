import { describe, expect, it } from 'vitest'
import type { SessionChain, SessionChainHandoffStep } from '../../../shared/session-chain-types'
import { describeSessionChain } from './session-chain-summary'

function summaryChain(
  overrides: Partial<SessionChain> & { end?: 'me' | 'done'; placement?: string } = {}
): SessionChain {
  return {
    id: 'chain',
    sourceRowKey: 'row',
    sourcePaneKey: 'pane',
    workspacePath: '/work',
    worktreeId: 'w1',
    hostId: null,
    auto: true,
    steps: [{ id: 'step', agent: 'claude', prompt: 'Review', status: 'queued' }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1_000_000_000,
    ...overrides
  }
}

function handedStep(): SessionChainHandoffStep {
  return {
    kind: 'handoff',
    id: 'handoff',
    status: 'delivered',
    handoff: {
      revision: 1,
      taskId: null,
      taskTitle: 'Review',
      sessionLabel: 'Review',
      recipients: [
        { employeeId: 'emp_uma', name: 'Uma', operationId: 'operation', delivery: 'sent' }
      ],
      deliverables: { kind: 'files', paths: [] },
      includeSummary: true,
      note: '',
      savedAt: 1
    }
  }
}

describe('describeSessionChain', () => {
  it('supports legacy agent steps and missing optional fields', () => {
    expect(describeSessionChain(summaryChain())).toEqual({
      summary: 'claude',
      current: 'Next: claude',
      placement: null,
      handedTo: null,
      ended: null
    })
  })
  it('describes placement and ending without claiming the queued agent is working', () => {
    expect(
      describeSessionChain(summaryChain({ end: 'done', placement: 'ssh:remote' }))
    ).toMatchObject({ summary: 'claude → End session', placement: 'ssh:remote', ended: 'done' })
    expect(
      describeSessionChain(summaryChain({ end: 'me', placement: 'local', state: 'ready' }))
    ).toMatchObject({ summary: 'claude → Back to me', placement: null, current: 'Ready to start' })
  })
  it('only reports handoff ownership after delivery and chain completion', () => {
    const chain = summaryChain({ steps: [handedStep()], state: 'done' })
    expect(describeSessionChain(chain)).toMatchObject({ handedTo: 'Uma', current: null })
    expect(describeSessionChain({ ...chain, state: 'failed' }).handedTo).toBeNull()
    chain.steps = [{ ...handedStep(), status: 'queued' }]
    expect(describeSessionChain(chain).handedTo).toBeNull()
  })
  it('never reports a review as a handoff of ownership', () => {
    const step = handedStep()
    const review: SessionChainHandoffStep = {
      ...step,
      handoff: { ...step.handoff, action: 'review' }
    }
    expect(
      describeSessionChain(summaryChain({ steps: [review], state: 'done' })).handedTo
    ).toBeNull()
  })
})

describe('describeSessionChain for an outcome run', () => {
  const now = 1_000_000_000

  it('never prints a blocked reason as what the run is doing', async () => {
    const { conversationPlanFixture } = await import('./conversation-plan-fixture')
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    // Why: a failed run holds no lock line; its diagnostic is for the details.
    expect(describeSessionChain(chain, now)).toMatchObject({
      summary: '0 of 1 outcomes complete',
      current: null,
      ended: null
    })
    chain.outcomeSet!.outcomes[0]!.block = {
      class: 'recovering',
      code: 'dispatch-stall',
      since: now - 1_000,
      until: now + 30_000
    }
    expect(describeSessionChain(chain, now).current).toBe('Recovering · retrying automatically')
  })

  it('reads a sealed run as ended, complete, through a lost host', async () => {
    const { conversationPlanFixture } = await import('./conversation-plan-fixture')
    const chain = conversationPlanFixture()
    chain.outcomeSet!.completion = {
      at: 50,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    expect(describeSessionChain(chain, now)).toMatchObject({
      summary: '1 of 1 outcomes complete',
      current: null,
      ended: 'done'
    })
  })
})
