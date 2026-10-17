import { describe, expect, it, vi } from 'vitest'
import { conversationPlanFixture } from '@/lib/conversation-plan-fixture'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import { sessionRunRowState } from '@/lib/session-run-row-state'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import {
  sessionRowDetailNotes,
  sessionRowStatus,
  showsQueueLine,
  type SessionRowStatusInput
} from './session-row-status'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const now = 1_000_000_000
const STALL = 'No activity was observed for 180s. The worker may have stalled.'

const session: SidebarSession = {
  rowKey: 'source',
  sessionKey: 'session-1',
  worktreeId: 'folder:1',
  hostId: 'local',
  tabId: 'source',
  paneKey: 'source:leaf-1',
  kind: 'terminal',
  label: 'Make a clock',
  workspaceLabel: 'Website',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

function queue(patch: Partial<SessionChainRowInfo> = {}): SessionChainRowInfo {
  return {
    chainId: 'chain',
    rowKey: 'source',
    queued: 2,
    total: 3,
    state: 'waiting',
    auto: true,
    error: null,
    destination: { kind: 'done' },
    blocked: null,
    launchedPaneKeys: [],
    ...patch
  }
}

function stalled(): SessionChain {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attempts = []
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = STALL
  return chain
}

function asking(): SessionChain {
  const chain = stalled()
  chain.outcomeSet!.attention = [
    {
      id: 'att_review-findings_outcome_1',
      kind: 'decision',
      scope: { outcomeId: 'outcome', outcomeRevision: 1 },
      ask: 'Decide what happens to 2 open review findings.',
      why: 'All 2 authorized review rounds are used; another one needs your say.',
      recipient: { type: 'owner' },
      action: { kind: 'open-up-next', label: 'Decide' },
      source: { type: 'review-findings', ref: 'rounds:2' },
      state: 'open',
      openedAt: 5
    }
  ]
  return chain
}

function input(
  chain: SessionChain | null,
  patch: Partial<SessionRowStatusInput> = {}
): SessionRowStatusInput {
  const archived = patch.archived ?? false
  return {
    session,
    chain: queue(),
    pursuitChain: chain,
    run: chain
      ? sessionRunRowState(chain, { now, archived, snoozed: Boolean(patch.waitingUntil) })
      : null,
    attention: null,
    returned: false,
    waitingUntil: null,
    locked: null,
    queued: true,
    completed: null,
    archived,
    now,
    ...patch
  }
}

describe('sessionRowStatus for an outcome run', () => {
  it('says the ask first, in the asking kind, and never the blocked reason', () => {
    expect(sessionRowStatus(input(asking()))).toEqual({
      kind: 'ask',
      text: 'Needs you: Decide what happens to 2 open review findings.',
      blockedReason: null,
      why: 'All 2 authorized review rounds are used; another one needs your say.'
    })
  })

  it('says Failed in plain words by code; the host’s sentence is for the details only', () => {
    // A legacy block carries no code, so the row can only say that recovery stopped.
    expect(sessionRowStatus(input(stalled()))).toEqual({
      kind: 'failed',
      text: 'Failed · Automatic recovery could not continue',
      reason: `Plan the work: ${STALL}`
    })
    const classified = stalled()
    classified.outcomeSet!.outcomes[0]!.block = {
      class: 'failed',
      code: 'worker-stalled',
      since: now - 1_000
    }
    const status = sessionRowStatus(input(classified))
    expect(status).toEqual({
      kind: 'failed',
      text: 'Failed · The agent stopped responding',
      reason: `Plan the work: ${STALL}`
    })
    expect(status?.text).not.toContain('No activity')
  })

  it('says a bare Failed for a run the host failed without a classified stop', () => {
    const chain = conversationPlanFixture()
    chain.state = 'failed'
    chain.error = 'The pane is gone. Reopen it.'
    const status = sessionRowStatus(input(chain))
    expect(status).toMatchObject({ kind: 'failed', text: 'Failed' })
    expect(status?.text).not.toContain('pane')
  })

  it('says Recovering and Waiting quietly while the host handles it', () => {
    const recovering = stalled()
    recovering.outcomeSet!.outcomes[0]!.block = {
      class: 'recovering',
      code: 'dispatch-stall',
      since: now - 1_000,
      until: now + 30_000
    }
    expect(sessionRowStatus(input(recovering))).toEqual({
      kind: 'recovering',
      text: 'Recovering · retrying automatically'
    })
    const waiting = stalled()
    waiting.outcomeSet!.outcomes[0]!.block = {
      class: 'waiting',
      code: 'evidence-poll',
      since: 1,
      wake: 'the pull request to merge'
    }
    expect(sessionRowStatus(input(waiting))).toEqual({
      kind: 'awaiting',
      text: 'Waiting for the pull request to merge'
    })
  })

  it('lets a snooze speak for a row the person put away, even one that asks', () => {
    const status = sessionRowStatus(input(asking(), { waitingUntil: '2099-01-01T00:00:00.000Z' }))
    expect(status?.kind).toBe('snoozed')
  })

  it('shows only the finished caption on a sealed run, with no queue line under it', () => {
    const chain = asking()
    chain.outcomeSet!.completion = {
      at: now - 5_000,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    const row = input(chain, { completed: { reason: 'done', at: now - 5_000 } })
    expect(sessionRowStatus(row)).toEqual({
      kind: 'caption',
      text: 'Plan finished · complete',
      reason: 'done'
    })
    expect(showsQueueLine(row)).toBe(false)
    expect(sessionRowDetailNotes(row, sessionRowStatus(row))).toMatchObject({
      reason: null,
      queue: null
    })
  })

  it('shows only "Archived" on an archived sealed, failed or cancelled run', () => {
    const sealed = stalled()
    sealed.outcomeSet!.completion = {
      at: now - 5_000,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    for (const chain of [sealed, stalled()]) {
      const row = input(chain, { archived: true })
      expect(sessionRowStatus(row)).toMatchObject({ kind: 'caption', text: 'Archived' })
      expect(sessionRowDetailNotes(row, sessionRowStatus(row))).toMatchObject({
        reason: null,
        queue: null
      })
    }
    // Why: a cancelled plan gives the row back, so it carries no run; its queue info says so.
    const cancelled = input(null, { archived: true, chain: queue({ state: 'cancelled' }) })
    expect(sessionRowStatus(cancelled)).toMatchObject({ kind: 'caption', text: 'Archived' })
    expect(sessionRowDetailNotes(cancelled, sessionRowStatus(cancelled)).queue).toBeNull()
  })
})

describe('sessionRowStatus for a queue without outcomes', () => {
  it('reads a failed queue as Failed, and as plain Archived once it is put away', () => {
    const failed = queue({ state: 'failed', error: 'The pane is gone. Reopen it.' })
    expect(sessionRowStatus(input(null, { chain: failed }))).toEqual({
      kind: 'failed',
      text: 'Failed · The pane is gone.',
      reason: 'The pane is gone. Reopen it.'
    })
    expect(sessionRowStatus(input(null, { chain: failed, archived: true }))).toMatchObject({
      kind: 'caption',
      text: 'Archived'
    })
  })

  it('still asks when a pane the queue waits on asked the person', () => {
    const parked = queue({ blocked: { paneKey: 'source:leaf-1', reason: 'waiting' } })
    expect(sessionRowStatus(input(null, { chain: parked }))).toMatchObject({
      kind: 'ask',
      text: 'Needs your answer · the plan carries on after'
    })
  })

  it('shows the queue line on a live queue', () => {
    expect(sessionRowStatus(input(null))).toEqual({ kind: 'queue', text: '2 sessions queued' })
  })
})
