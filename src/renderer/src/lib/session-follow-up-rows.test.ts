import { describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import type { SessionFollowUpRule } from '../../../shared/session-follow-up-rule'

vi.mock('@/lib/session-chain-registry', () => ({ useSessionFollowUpChains: () => [] }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const { isSessionFollowUpReady, sessionFollowUpRow } = await import('./session-follow-up-rows')

function rule(extra: Partial<SessionFollowUpRule> = {}): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_abcd1234',
    taskTitle: 'Webinar intro',
    sessionLabel: 'Draft',
    recipients: [
      { employeeId: 'emp_iris', name: 'Iris', operationId: 'fu_iris_op', delivery: 'pending' },
      { employeeId: 'emp_gamma', name: 'Gamma', operationId: 'fu_gamma_op', delivery: 'pending' }
    ],
    action: 'review',
    deliverables: { kind: 'manifest', manifestPath: '/w/.omni/runs/c/s/manifest.md' },
    includeSummary: false,
    note: 'Please review',
    dueAt: '2026-09-11T21:00:00.000Z',
    savedAt: 1,
    ...extra
  }
}

function chain(handoff: SessionFollowUpRule, extra: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'chn_f',
    workspacePath: '/w',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    steps: [{ kind: 'handoff', id: 'step_h', status: 'queued', handoff }],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: Date.UTC(2026, 8, 11, 9, 0),
    ...extra
  }
}

describe('saved follow-up rows', () => {
  it('shows a rule waiting on its run without claiming anyone received anything', () => {
    expect(sessionFollowUpRow(chain(rule()))).toEqual({
      id: 'chn_f',
      taskId: 'btk_abcd1234',
      title: 'Webinar intro',
      recipientIds: ['emp_iris', 'emp_gamma'],
      hasAgentRecipients: false,
      action: 'review',
      state: 'waiting-for-run',
      threadIds: [],
      detail: null,
      dueAt: '2026-09-11T21:00:00.000Z',
      updatedAt: '2026-09-11T09:00:00.000Z'
    })
    expect(
      sessionFollowUpRow(chain(rule({ waitingForFiles: ['manifest.md', 'deck.pptx'] })))?.detail
    ).toBe('Waiting for final files: manifest.md, deck.pptx')
  })

  it('is delivering from capture until every person is acknowledged', () => {
    expect(sessionFollowUpRow(chain(rule(), { state: 'launching' }))?.state).toBe('delivering')
    expect(sessionFollowUpRow(chain(rule({ capturedAt: 5 })))?.state).toBe('delivering')
    const sent = rule({
      recipients: rule().recipients.map((person) => ({
        ...person,
        delivery: 'sent' as const,
        threadId: `hth_${person.employeeId.slice(4)}`
      }))
    })
    expect(sessionFollowUpRow(chain(sent, { state: 'done' }))).toMatchObject({
      state: 'delivered',
      hasAgentRecipients: false,
      threadIds: ['hth_iris', 'hth_gamma']
    })
  })

  it('shows a partial delivery as an exception that keeps the thread that did go out', () => {
    const partial = rule({
      capturedAt: 5,
      recipients: [
        { ...rule().recipients[0]!, delivery: 'failed', error: 'HTTP 403' },
        { ...rule().recipients[1]!, delivery: 'sent', threadId: 'hth_gamma' }
      ],
      exception: { code: 'rejected', subject: 'Iris', detail: 'HTTP 403', at: 9 }
    })
    expect(sessionFollowUpRow(chain(partial, { state: 'failed' }))).toMatchObject({
      state: 'exception',
      threadIds: ['hth_gamma'],
      detail: 'The request to Iris was refused: HTTP 403'
    })
    expect(
      sessionFollowUpRow(chain(rule(), { state: 'failed', error: 'The pane is gone.' }))?.detail
    ).toBe('The pane is gone.')
  })

  it("carries an ask only while the rule's run holds an open request for its owner", async () => {
    const { conversationPlanFixture } = await import('./conversation-plan-fixture')
    const { followUpRow } = await import('../../../shared/backoffice-work-rows')
    const now = 1_000_000_000
    const plan = conversationPlanFixture()
    plan.outcomeSet!.attempts = []
    plan.outcomeSet!.outcomes[0]!.status = 'blocked'
    plan.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    const failed = chain(rule(), {
      state: 'failed',
      error: 'The pane is gone.',
      outcomeSet: plan.outcomeSet
    })
    // Why: a failed chain with a blocked reason is an exception row, never the reader's move.
    const silent = sessionFollowUpRow(failed, now)!
    expect(silent).toMatchObject({ state: 'exception', detail: 'The pane is gone.' })
    expect('ask' in silent).toBe(false)
    expect(followUpRow(silent)).toMatchObject({ kind: 'exception', needsYou: false })

    plan.outcomeSet!.attention = [
      {
        id: 'att_provider-authentication_outcome_1',
        kind: 'credential',
        scope: { outcomeId: 'outcome', outcomeRevision: 1 },
        ask: 'Sign claude in again.',
        why: "claude's provider rejected its sign-in, and only you hold those credentials.",
        recipient: { type: 'owner' },
        source: { type: 'provider-authentication', ref: 'claude' },
        state: 'open',
        openedAt: 5
      }
    ]
    const asked = sessionFollowUpRow(failed, now)!
    expect(asked.ask).toBe('Sign claude in again.')
    expect(followUpRow(asked)).toMatchObject({
      kind: 'exception',
      why: 'Sign claude in again.',
      nextActor: { kind: 'me' },
      needsYou: true
    })
  })

  it('keeps the presence of agent recipients separate from human thread receipts', () => {
    const mixed = rule({
      agentRecipients: [
        {
          kind: 'agent',
          id: 'pc_agent',
          name: 'Agent',
          employeeId: 'emp_iris',
          projectId: 'proj_one',
          operationId: 'agent_operation',
          delivery: 'sent',
          messageId: `pm_${'a'.repeat(24)}`
        }
      ]
    })
    expect(sessionFollowUpRow(chain(mixed))).toMatchObject({
      recipientIds: ['emp_iris', 'emp_gamma'],
      hasAgentRecipients: true,
      threadIds: []
    })
  })

  it('asks for a confirmation only while named files sit ready at a stop', () => {
    const ready = rule({ deliverables: { kind: 'files', paths: ['/w/report.md'] }, readyAt: 5 })
    expect(sessionFollowUpRow(chain(ready))).toMatchObject({
      state: 'waiting-for-run',
      detail: expect.stringContaining('Send now if the work is finished')
    })
    expect(isSessionFollowUpReady(chain(ready))).toBe(true)
    expect(isSessionFollowUpReady(chain({ ...ready, confirmedAt: 6 }))).toBe(false)
    expect(isSessionFollowUpReady(chain(ready, { state: 'cancelled' }))).toBe(false)
    expect(isSessionFollowUpReady(chain(rule()))).toBe(false)
  })

  it('keeps a cancelled rule as cancelled and ignores queue chains', () => {
    expect(sessionFollowUpRow(chain(rule(), { state: 'cancelled' }))?.state).toBe('cancelled')
    expect(
      sessionFollowUpRow(
        chain(rule(), {
          steps: [{ id: 's1', agent: 'claude', prompt: 'go', status: 'queued' }]
        })
      )
    ).toBeNull()
  })
})
