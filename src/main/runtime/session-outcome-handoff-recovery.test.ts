import { describe, expect, it } from 'vitest'
import type { HandoffSendCardless } from '../../shared/console-handoff-contract'
import {
  SESSION_RECOVERY_BACKOFF_MS,
  SESSION_RECOVERY_MAX_AUTO_RETRIES
} from '../../shared/session-attempt-recovery'
import type { SessionChain, SessionChainHandoffStep } from '../../shared/session-chain-types'
import {
  executeSessionOutcomeHandoff,
  installSessionOutcomeHandoffTransport,
  sessionOutcomeHandoffBlocker
} from './session-outcome-handoff'
import {
  decideSessionOutcomeHandoffRecovery,
  rekeyRefusedSessionOutcomeHandoff,
  sessionOutcomeHandoffException,
  sessionOutcomeHandoffResendsUsed
} from './session-outcome-handoff-recovery'
import { normalizeException } from '../../shared/session-follow-up-rule-fields'

const T0 = 5_000_000
const [FIRST_BACKOFF, SECOND_BACKOFF] = SESSION_RECOVERY_BACKOFF_MS

function chainWith(step: SessionChainHandoffStep): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [step],
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        principal: 'company:person',
        state: 'owned'
      },
      outcomes: [
        {
          id: 'delivery',
          title: 'Hand off',
          finish: 'human-handoff',
          dependsOn: [],
          stepIds: ['handoff'],
          actions: [],
          conditions: [
            { id: 'handoff', kind: 'handoff', target: 'emp_maya', recipientId: 'emp_maya' }
          ],
          revision: 1,
          status: 'pending',
          evidence: []
        }
      ]
    }
  }
}

/** Already captured and message-only, so a send is the only effect these rows exercise. */
const messageOnly = (): SessionChainHandoffStep => ({
  kind: 'handoff',
  id: 'handoff',
  outcomeId: 'delivery',
  status: 'queued',
  handoff: {
    revision: 1,
    taskId: null,
    taskTitle: 'Review the export',
    sessionLabel: 'Export',
    recipients: [
      { employeeId: 'emp_maya', name: 'Maya', operationId: 'operation_1', delivery: 'pending' }
    ],
    action: 'review',
    disposition: 'ownership-transfer',
    deliverables: { kind: 'files', paths: [] },
    includeSummary: false,
    note: 'Please take this over',
    savedAt: 1,
    capturedAt: 2,
    files: []
  }
})

/** A hub whose answer the test scripts, with the pause between replays removed. */
function hub(answer: () => 'sent' | 'refuse' | 'silence') {
  const sent: HandoffSendCardless[] = []
  installSessionOutcomeHandoffTransport({
    principal: async () => 'company:person',
    sleep: async () => {},
    hub: {
      upload: async (_task, file) => ({ path: file.name, sha256: file.sha256 }),
      send: async () => {
        throw new Error('card-less only')
      },
      sendCardless: async (input) => {
        sent.push(input)
        const next = answer()
        if (next === 'sent') {
          return { thread_id: 'hth_delivered' }
        }
        throw new Error(next === 'refuse' ? 'recipient not in roster' : 'socket hang up')
      },
      uploadThreadFile: async () => ({ thread_id: 'hth_delivered' }),
      isRejected: (error) => error instanceof Error && error.message.includes('roster')
    }
  })
  return sent
}

function store(initial: SessionChain) {
  let chain = initial
  const step = (): SessionChainHandoffStep => chain.steps[0] as SessionChainHandoffStep
  return {
    step,
    chain: () => chain,
    /** What the step runner does: ask the blocker, and send only when it holds nothing. */
    advance: async (now: number): Promise<'held' | 'delivered' | 'failed'> => {
      if (sessionOutcomeHandoffBlocker(step(), now)) {
        return 'held'
      }
      try {
        await executeSessionOutcomeHandoff({
          chain,
          step: step(),
          summary: 'Done',
          read: () => chain,
          save: (next) => {
            chain = next
          },
          now
        })
        return 'delivered'
      } catch {
        return 'failed'
      }
    }
  }
}

describe('the recovery decision', () => {
  const rule = messageOnly().handoff
  const failed = (code: 'unconfirmed' | 'rejected' | 'duplicate-names', detail = 'boom') => ({
    ...rule,
    exception: { code, subject: 'Maya', detail, at: T0 }
  })

  it('does nothing about a handoff that has not failed', () => {
    expect(decideSessionOutcomeHandoffRecovery(rule, T0)).toEqual({ kind: 'none' })
  })

  it('waits out the backoff, then resends: the same key unless the hub refused the last one', () => {
    expect(decideSessionOutcomeHandoffRecovery(failed('unconfirmed'), T0 + 1)).toEqual({
      kind: 'wait',
      rung: 0,
      until: T0 + FIRST_BACKOFF,
      code: 'handoff-unconfirmed'
    })
    expect(decideSessionOutcomeHandoffRecovery(failed('unconfirmed'), T0 + FIRST_BACKOFF)).toEqual({
      kind: 'resend',
      rung: 0,
      rekey: false
    })
    expect(decideSessionOutcomeHandoffRecovery(failed('rejected'), T0 + FIRST_BACKOFF)).toEqual({
      kind: 'resend',
      rung: 0,
      rekey: true
    })
  })

  it('counts the resends it already spent from the failure it recorded, across a restart', () => {
    const spend = (resends: number, message = 'boom') => ({
      ...rule,
      exception: sessionOutcomeHandoffException({
        code: 'unconfirmed',
        subject: 'Maya',
        message,
        resends,
        at: T0
      })
    })
    const once = spend(1)
    // The count is a field of its own; the person's diagnostic stays the failure's own words.
    expect(once.exception).toEqual({
      code: 'unconfirmed',
      subject: 'Maya',
      detail: 'boom',
      at: T0,
      retries: 1
    })
    expect(spend(0).exception).not.toHaveProperty('retries')
    // A restart reads the failure back through the rule's normalizer, which keeps the count.
    const reloaded = {
      ...rule,
      exception: normalizeException(JSON.parse(JSON.stringify(once.exception)))
    }
    expect(reloaded.exception).toEqual(once.exception)
    expect(sessionOutcomeHandoffResendsUsed(reloaded)).toBe(1)
    expect(decideSessionOutcomeHandoffRecovery(reloaded, T0 + FIRST_BACKOFF)).toMatchObject({
      kind: 'wait',
      rung: 1,
      until: T0 + SECOND_BACKOFF
    })
    expect(
      decideSessionOutcomeHandoffRecovery(
        spend(SESSION_RECOVERY_MAX_AUTO_RETRIES),
        T0 + 10 * SECOND_BACKOFF
      )
    ).toEqual({ kind: 'fail', code: 'handoff-delivery' })
  })

  it('still reads the count a record written before the field carried in its detail', () => {
    const legacy = failed('unconfirmed', 'boom [automatic resend 2 of 2]')
    expect(sessionOutcomeHandoffResendsUsed(legacy)).toBe(SESSION_RECOVERY_MAX_AUTO_RETRIES)
    expect(decideSessionOutcomeHandoffRecovery(legacy, T0 + 10 * SECOND_BACKOFF)).toEqual({
      kind: 'fail',
      code: 'handoff-delivery'
    })
    // The next failure of that rule moves the count to the field and takes the note off the words.
    expect(
      sessionOutcomeHandoffException({
        code: 'unconfirmed',
        subject: 'Maya',
        message: legacy.exception.detail,
        resends: 2,
        at: T0
      })
    ).toMatchObject({ detail: 'boom', retries: 2 })
  })

  it('never resends a deterministic packaging error', () => {
    expect(decideSessionOutcomeHandoffRecovery(failed('duplicate-names'), T0 + 1)).toEqual({
      kind: 'fail',
      code: 'handoff-duplicate-names'
    })
  })

  it('re-keys only the refused recipient', () => {
    const rekeyed = rekeyRefusedSessionOutcomeHandoff(
      {
        ...rule,
        recipients: [
          { ...rule.recipients[0]!, delivery: 'failed', error: 'not in roster' },
          { employeeId: 'emp_inez', name: 'Ines', operationId: 'operation_2', delivery: 'sent' }
        ]
      },
      () => 'fresh_operation'
    )
    expect(rekeyed.recipients).toEqual([
      { employeeId: 'emp_maya', name: 'Maya', operationId: 'fresh_operation', delivery: 'pending' },
      { employeeId: 'emp_inez', name: 'Ines', operationId: 'operation_2', delivery: 'sent' }
    ])
  })

  it('resends a refused re-ask as the same round, on the same thread', () => {
    const plan = {
      operationId: 'operation_round_2',
      threadId: 'hth_maya',
      note: 'Updated after your notes (round 2).',
      files: []
    }
    const rekeyed = rekeyRefusedSessionOutcomeHandoff(
      {
        ...rule,
        reask: true,
        recipients: [
          {
            ...rule.recipients[0]!,
            operationId: 'operation_round_2',
            delivery: 'failed',
            error: 'The hub refused it.',
            round: 2,
            threadId: 'hth_maya',
            reaskPlan: plan
          }
        ]
      },
      () => 'fresh_operation'
    )
    // Still round 2 on Maya's thread, so the delivery answers there (`isFollowUpReask`) and the
    // next re-ask counts on to round 3. The plan answered only for the refused key.
    expect(rekeyed.recipients).toEqual([
      {
        employeeId: 'emp_maya',
        name: 'Maya',
        operationId: 'fresh_operation',
        delivery: 'pending',
        round: 2,
        threadId: 'hth_maya'
      }
    ])
    // An opening request that was refused has no thread to go back to, and keeps no round.
    expect(
      rekeyRefusedSessionOutcomeHandoff(
        { ...rule, recipients: [{ ...rule.recipients[0]!, delivery: 'failed' }] },
        () => 'fresh_operation'
      ).recipients[0]
    ).toEqual({
      employeeId: 'emp_maya',
      name: 'Maya',
      operationId: 'fresh_operation',
      delivery: 'pending'
    })
  })
})

describe('a transient handoff failure', () => {
  it('is sent again by the host with the SAME key, delivers, and leaves no failure behind', async () => {
    let up = false
    const sent = hub(() => (up ? 'sent' : 'silence'))
    const run = store(chainWith(messageOnly()))

    expect(await run.advance(T0)).toBe('failed')
    expect(run.step().handoff.exception).toMatchObject({ code: 'unconfirmed', at: T0 })
    expect(run.step().handoff.recipients[0]!.delivery).toBe('sending')
    const firstSends = sent.length

    // Backing off: the blocker holds and nothing leaves.
    expect(await run.advance(T0 + FIRST_BACKOFF - 1)).toBe('held')
    expect(sent).toHaveLength(firstSends)

    up = true
    expect(await run.advance(T0 + FIRST_BACKOFF)).toBe('delivered')
    expect(new Set(sent.map((input) => input.operationId))).toEqual(new Set(['operation_1']))
    expect(run.step()).toMatchObject({ status: 'delivered' })
    expect(run.step().handoff.exception).toBeUndefined()
    expect(run.step().handoff.recipients[0]).toMatchObject({
      delivery: 'sent',
      threadId: 'hth_delivered'
    })
  })

  it('stops after the bounded resends and then sends nothing more by itself', async () => {
    const sent = hub(() => 'silence')
    const run = store(chainWith(messageOnly()))

    expect(await run.advance(T0)).toBe('failed')
    expect(await run.advance(T0 + FIRST_BACKOFF)).toBe('failed')
    expect(sessionOutcomeHandoffResendsUsed(run.step().handoff)).toBe(1)
    const second = T0 + FIRST_BACKOFF + SECOND_BACKOFF
    expect(await run.advance(second - 1)).toBe('held')
    expect(await run.advance(second)).toBe('failed')
    expect(sessionOutcomeHandoffResendsUsed(run.step().handoff)).toBe(2)

    const spent = sent.length
    for (const later of [second + 1, second + SECOND_BACKOFF, second + 100 * SECOND_BACKOFF]) {
      expect(await run.advance(later)).toBe('held')
      expect(decideSessionOutcomeHandoffRecovery(run.step().handoff, later)).toEqual({
        kind: 'fail',
        code: 'handoff-delivery'
      })
    }
    expect(sent).toHaveLength(spent)
  })

  it('re-keys a request the hub refused before sending it again', async () => {
    let accepting = false
    const sent = hub(() => (accepting ? 'sent' : 'refuse'))
    const run = store(chainWith(messageOnly()))

    expect(await run.advance(T0)).toBe('failed')
    expect(run.step().handoff.recipients[0]).toMatchObject({ delivery: 'failed' })
    expect(run.step().handoff.exception).toMatchObject({ code: 'rejected' })

    accepting = true
    expect(await run.advance(T0 + FIRST_BACKOFF)).toBe('delivered')
    expect(sent.map((input) => input.operationId)).toEqual([
      'operation_1',
      run.step().handoff.recipients[0]!.operationId
    ])
    expect(run.step().handoff.recipients[0]!.operationId).not.toBe('operation_1')
    // Hand off: verified delivery is the end of it for the sender.
    expect(run.step().handoff.recipients[0]!.ownershipTransferredAt).toBeTypeOf('number')
  })

  it('never writes a late failure onto a sealed run', async () => {
    hub(() => 'silence')
    const sealed = chainWith(messageOnly())
    sealed.outcomeSet = {
      ...sealed.outcomeSet!,
      completion: { at: 5, outcomes: [{ id: 'delivery', revision: 1 }], evidenceIds: [] }
    }
    let writes = 0
    await expect(
      executeSessionOutcomeHandoff({
        chain: sealed,
        step: sealed.steps[0] as SessionChainHandoffStep,
        summary: 'Done',
        read: () => sealed,
        save: (next) => {
          // The delivery engine's own markers are the send, not a failure written back.
          const saved = next.steps[0] as SessionChainHandoffStep
          writes += saved.handoff.exception ? 1 : 0
        },
        now: T0
      })
    ).rejects.toThrow()
    expect(writes).toBe(0)
  })
})
