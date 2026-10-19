import { describe, expect, it, vi } from 'vitest'
import { normalizeSessionChain, type SessionChain } from '../../shared/session-chain-types'
import {
  recordSessionOutcomeEvidence,
  reviseSessionOutcomeSet
} from '../../shared/session-outcome-state'
import { sessionOutcomeConditionKey } from '../../shared/session-outcome-types'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry, SessionTidyRow } from '../../shared/session-manage-types'
import {
  PERSON_STARTED_TIDY_HOLD,
  applySessionTidy,
  classifySessionTidy,
  classifySessionTidyFor,
  planSessionTidy,
  sessionTidyHoldReason
} from './session-manage-tidy'
import { manageEntry, sidebarRow } from './session-manage-test-fixtures'

const ROW = sidebarRow({ agentSession: true })

/** A recorded commitment for ROW's conversation, sealed complete with every receipt. */
function provenChain(): SessionChain {
  const condition = { id: 'merge', kind: 'merge' as const, target: 'https://example.test/pull/1' }
  let set = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'delivery',
          title: 'Merged',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [condition]
        }
      ]
    },
    {
      owner: 'execution-host',
      hostId: 'local',
      epoch: 'epoch',
      state: 'owned',
      sourceVersion: 'turn1',
      sourceReady: true
    },
    1
  )
  set = recordSessionOutcomeEvidence(set, {
    id: condition.id,
    outcomeId: 'delivery',
    conditionId: condition.id,
    outcomeRevision: 1,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    receipt: 'verified:merge',
    verifiedAt: 2,
    verifier: 'execution-host'
  })
  return normalizeSessionChain({
    id: 'chain',
    workspacePath: '/w',
    worktreeId: ROW.worktreeId,
    sourcePaneKey: ROW.paneKey!,
    sourceRowKey: ROW.rowKey,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'done',
    createdAt: 1,
    updatedAt: 3,
    outcomeSet: sealSessionRunCompletion(set, { now: 3, operationId: 'tidy' })
  })!
}

function entry(overrides: Partial<SessionManageEntry> = {}): SessionManageEntry {
  return manageEntry({ paneKey: ROW.paneKey, tabId: ROW.tabId, title: ROW.title, ...overrides })
}

function classify(
  entryOverrides: Partial<SessionManageEntry> = {},
  rowOverrides: Partial<SessionManageSidebarRow> = {},
  hold: string | null = null,
  include: string[] = []
) {
  return classifySessionTidy(
    sidebarRow({ agentSession: true, ...rowOverrides }),
    entry(entryOverrides),
    hold,
    new Set(include)
  )
}

describe('session tidy planner', () => {
  it('archives exited sessions and idle ones with nothing open', () => {
    expect(classify({ state: 'exited', verdict: 'exited' })).toEqual({
      action: 'archive',
      reason: 'Exited.'
    })
    expect(classify({ state: 'idle' }).action).toBe('archive')
  })

  // Sal, 2026-10-19: "human started sessions stay open until we close them."
  it('holds a session a person started, or one an older window does not say, unless named', () => {
    for (const agentSession of [false, undefined]) {
      for (const state of [
        { state: 'idle' as const },
        { state: 'exited' as const, verdict: 'exited' as const }
      ]) {
        expect(classify(state, { agentSession })).toEqual({
          action: 'hold',
          reason: PERSON_STARTED_TIDY_HOLD,
          group: 'held'
        })
        expect(classify(state, { agentSession }, null, [ROW.paneKey!])).toMatchObject({
          action: 'archive',
          included: true
        })
      }
    }
    // A skip still beats --include: a person's session with something open stays.
    expect(
      classify({ pendingSteps: ['Deploy it'] }, { agentSession: false }, null, [ROW.paneKey!])
    ).toMatchObject({ action: 'skip', group: 'open-items' })
    // Another hold still names its own reason first.
    expect(
      classify({}, { agentSession: false }, 'Its recorded outcomes are not finished.')
    ).toEqual({
      action: 'hold',
      reason: 'Its recorded outcomes are not finished.',
      group: 'held'
    })
  })

  it('skips idle sessions with a pending step, a queue or something waiting on the person', () => {
    expect(classify({ pendingSteps: ['Deploy it'] }).action).toBe('skip')
    expect(classify({ queueLength: 1 }).action).toBe('skip')
    expect(classify({ waitingOn: 'Its last turn failed: boom' })).toMatchObject({
      action: 'skip',
      reason: expect.stringContaining('Its last turn failed')
    })
  })

  it('never archives unknown, unverifiable or host-unavailable sessions', () => {
    expect(classify({ state: 'unknown' })).toMatchObject({
      action: 'skip',
      reason: expect.stringContaining('unknown')
    })
    expect(classify({ state: 'unknown', verdict: 'unverifiable' })).toMatchObject({
      action: 'skip',
      reason: expect.stringContaining('unverifiable')
    })
    expect(classify({ state: 'exited' }, { hostUnavailable: true }).action).toBe('skip')
  })

  it('skips sessions another computer or an SSH host executes', () => {
    const verdict = classify({ state: 'exited', hostId: 'ssh:box-1' })
    expect(verdict.action).toBe('skip')
    expect(verdict.reason).toContain('SSH host box-1')
    expect(classify({ state: 'idle', hostId: 'runtime:env-2' }).reason).toContain(
      'another OmniConsole'
    )
  })

  it('names which unreachable case a skip is, for the report', () => {
    const unverifiable = { state: 'exited' as const, verdict: 'unverifiable' as const }
    expect(classify({ ...unverifiable, hostId: 'runtime:env-2' })).toMatchObject({
      group: 'other-omniconsole',
      reason: expect.stringContaining('another OmniConsole')
    })
    expect(
      classify({ state: 'exited', hostId: 'ssh:box-1' }, { hostUnavailable: true })
    ).toMatchObject({ group: 'host-disconnected' })
    expect(classify({ state: 'exited', hostId: 'ssh:box-1' }).group).toBe('ssh-host')
    expect(classify(unverifiable).group).toBe('unverifiable')
    expect(classify({ state: 'working' }).group).toBe('busy')
    expect(classify({}, {}, 'Its recorded outcomes are not finished.').group).toBe('held')
    expect(classify({ state: 'exited' })).not.toHaveProperty('group')
  })

  it('skips pinned, Saved, archived and still-launching sessions', () => {
    expect(classify({ state: 'exited', pinned: true })).toEqual({
      action: 'skip',
      reason: 'Pinned.',
      group: 'pinned'
    })
    expect(classify({ saved: true, folder: 'Saved Sessions / Q3' })).toEqual({
      action: 'skip',
      reason: 'Saved (Saved Sessions / Q3).',
      group: 'saved'
    })
    expect(classify({ archived: true }).reason).toBe('Already archived.')
    expect(classify({}, { launchPending: true }).reason).toBe('Its launch is still pending.')
    expect(classify({ paneKey: null }).action).toBe('skip')
  })

  it.each(['working', 'queued', 'provider-limited', 'awaiting-user', 'waiting-for-yes'] as const)(
    'skips %s sessions, even when named',
    (state) => {
      expect(
        classify({ state }, {}, 'Its recorded outcomes are not finished.', [ROW.paneKey!])
      ).toMatchObject({ action: 'skip' })
    }
  )

  it('holds an open commitment unless the request names it', () => {
    const hold = 'Its recorded outcomes are not finished.'
    expect(classify({ state: 'exited' }, {}, hold)).toEqual({
      action: 'hold',
      reason: hold,
      group: 'held'
    })
    expect(classify({ state: 'exited' }, {}, hold, [ROW.paneKey!])).toEqual({
      action: 'archive',
      reason: `Held (${hold}) but the request names it.`,
      included: true
    })
  })

  it('flags junk titles and counts each action', () => {
    const plan = planSessionTidy(
      [
        { row: ROW, entry: entry({ state: 'exited', title: 'worker-task_5ad8df40da3a' }) },
        { row: ROW, entry: entry({ state: 'working', title: 'Parser fix' }) },
        { row: ROW, entry: entry({ state: 'idle', title: 'claude conversation' }) }
      ],
      () => null,
      new Set()
    )
    expect(plan.counts).toEqual({ archive: 2, hold: 0, skip: 1, junkTitles: 2 })
    expect(plan.titleFlags.map((flag) => flag.title)).toEqual([
      'worker-task_5ad8df40da3a',
      'claude conversation'
    ])
    expect(plan.rows[0]).toMatchObject({ action: 'archive', paneKey: ROW.paneKey, state: 'exited' })
  })
})

describe('session tidy answer waits', () => {
  const waiting = 'Kept: waiting on your decision (plan.md).'

  it('keeps a session waiting on the person, named or not, in archive and delete', () => {
    const answerWait = vi.fn((row: { paneKey: string | null }) =>
      row.paneKey === ROW.paneKey ? waiting : null
    )
    const exited = entry({ state: 'exited', verdict: 'exited' })
    for (const mode of [{ answerWait }, { delete: true, unverified: true, answerWait }]) {
      expect(classifySessionTidyFor(mode, ROW, exited, null, new Set([ROW.paneKey!]))).toEqual({
        action: 'skip',
        reason: waiting,
        group: 'awaiting-answer'
      })
    }
    expect(answerWait).toHaveBeenCalledWith(ROW)
    const other = sidebarRow({ agentSession: true, paneKey: 'tab-9:1' })
    expect(classifySessionTidyFor({ answerWait }, other, exited, null, new Set()).action).toBe(
      'archive'
    )
  })

  it('shows the kept row with its reason in the plan', () => {
    const plan = planSessionTidy(
      [{ row: ROW, entry: entry({ state: 'exited' }) }],
      () => null,
      new Set(),
      { answerWait: () => waiting }
    )
    expect(plan.rows[0]).toMatchObject({
      action: 'skip',
      reason: waiting,
      group: 'awaiting-answer'
    })
    expect(plan.counts).toMatchObject({ archive: 0, skip: 1 })
  })
})

describe('session tidy commitments', () => {
  it('holds nothing for a conversation with no chain or a proven-complete one', () => {
    expect(sessionTidyHoldReason([], ROW)).toBeNull()
    expect(sessionTidyHoldReason([provenChain()], ROW)).toBeNull()
  })

  it('holds unfinished, quarantined, attention-open and older-plan commitments', () => {
    const unfinished = { ...provenChain(), state: 'waiting' as const }
    delete unfinished.outcomeSet!.completion
    expect(sessionTidyHoldReason([unfinished], ROW)).not.toBeNull()

    const quarantined = {
      ...provenChain(),
      quarantine: { reason: 'drift', at: 1 }
    } as unknown as SessionChain
    expect(sessionTidyHoldReason([quarantined], ROW)).toBe(
      'Its recorded outcome run is quarantined.'
    )

    const review = provenChain()
    review.outcomeSet!.outcomes[0]!.evidence[0]!.receipt = 'done-for-review:v1'
    expect(sessionTidyHoldReason([review], ROW)).not.toBeNull()

    const olderPlan = provenChain()
    olderPlan.planVersion = 2
    expect(sessionTidyHoldReason([olderPlan], ROW)).not.toBeNull()
  })

  it('ignores chains of other conversations and holds a live plain session chain', () => {
    const other = {
      ...provenChain(),
      state: 'waiting' as const,
      sourceRowKey: 'x',
      sourcePaneKey: 'p'
    }
    delete other.outcomeSet!.completion
    expect(sessionTidyHoldReason([other], ROW)).toBeNull()
    const plain = { ...provenChain(), outcomeSet: undefined, state: 'waiting' as const }
    expect(sessionTidyHoldReason([plain], ROW)).toBe('Its session chain still has steps to run.')
  })
})

describe('session tidy apply', () => {
  const planned = planSessionTidy(
    [
      { row: ROW, entry: entry({ state: 'exited' }) },
      { row: ROW, entry: entry({ paneKey: 'tab-2:leaf-1', tabId: 'tab-2', state: 'idle' }) },
      { row: ROW, entry: entry({ paneKey: 'tab-3:leaf-1', tabId: 'tab-3', state: 'working' }) }
    ],
    () => null,
    new Set()
  ).rows

  it('archives exactly the archive rows, each re-checked first', async () => {
    const archive = vi.fn(async (_row: SessionTidyRow) => ({}))
    const recheck = vi.fn(async () => ({ action: 'archive' as const, reason: 'Exited.' }))
    const result = await applySessionTidy(planned, { recheck, archive })
    expect(archive.mock.calls.map(([row]) => row.paneKey)).toEqual(['tab-1:leaf-1', 'tab-2:leaf-1'])
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(result.applied).toEqual({ archived: 2, skipped: 0, failed: 0 })
    expect(result.rows[2]).not.toHaveProperty('outcome')
  })

  it('skips a target whose state changed since the plan, or that left the sidebar', async () => {
    const archive = vi.fn(async () => ({}))
    const result = await applySessionTidy(planned, {
      recheck: async (row) =>
        row.paneKey === 'tab-1:leaf-1' ? { action: 'skip', reason: 'Working.' } : null,
      archive
    })
    expect(archive).not.toHaveBeenCalled()
    expect(result.applied).toEqual({ archived: 0, skipped: 2, failed: 0 })
    expect(result.rows[0]).toMatchObject({
      outcome: 'skipped',
      outcomeReason: 'Changed since the plan: Working.'
    })
    expect(result.rows[1]).toMatchObject({ outcome: 'skipped' })
  })

  it('reports a failed archive per row and carries audit warnings', async () => {
    const result = await applySessionTidy(planned, {
      recheck: async () => ({ action: 'archive', reason: 'Exited.' }),
      archive: async (row) => {
        if (row.paneKey === 'tab-1:leaf-1') {
          throw new Error('“Parser fix” is already archived.')
        }
        return { auditError: 'disk full' }
      }
    })
    expect(result.applied).toEqual({ archived: 1, skipped: 0, failed: 1 })
    expect(result.rows[0]).toMatchObject({
      outcome: 'failed',
      outcomeReason: '“Parser fix” is already archived.'
    })
    expect(result.rows[1]).toMatchObject({ outcome: 'archived', auditError: 'disk full' })
  })
})
