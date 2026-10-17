import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import {
  restoreAcceptedWorkerTerminalReleaseRequests,
  workerHasOpenObligations
} from './db/worker-terminal/worker-terminal-accepted-release'

const paneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const processIncarnation = 'runtime:pty:1'
const hostScope = JSON.stringify({ kind: 'local', hostId: 'local' })

function fixture(disposable = true) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'Accepted completion cleanup',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const start = (ownership: 'created' | 'external' = 'created') => {
    const task = db.createTask({ spec: 'Disposable worker', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {
        agent: 'codex',
        ...(disposable
          ? {
              completionPolicy: {
                kind: 'release_on_accepted_completion',
                coordinator: {
                  worktreeId: 'folder:workspace',
                  paneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                }
              }
            }
          : {})
      }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey,
      processIncarnation,
      worktreeId: 'folder:workspace',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: ownership,
      hostScope
    })
    db.markWorkerDispatchReady(dispatch.id)
    return { task, dispatch }
  }
  const { task, dispatch } = start()
  const report = (outcome: 'succeeded' | 'failed' = 'succeeded') => {
    const message = db.insertMessage({
      from: 'term_worker',
      senderPaneKey: paneKey,
      to: `run:${run.id}`,
      runId: run.id,
      type: 'worker_done',
      subject: 'Completed',
      body: 'Result saved.',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome })
    })
    expect(reconcileLifecycleMessage(db, message).action).toBe(
      outcome === 'succeeded' ? 'completed' : 'failed'
    )
    return message
  }
  const deliver = () =>
    db.getOrCreateRunDelivery({ runId: run.id, consumerGeneration: run.consumer_generation })!
  const ack = (deliveryId: string) =>
    db.acknowledgeRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      deliveryId
    })
  return { db, run, task, dispatch, start, report, deliver, ack }
}

describe('accepted worker completion cleanup', () => {
  let f: ReturnType<typeof fixture>
  afterEach(() => {
    f?.db.close()
    vi.restoreAllMocks()
  })

  it('leaves legacy and unspecified worker launches under manual lifecycle control', () => {
    f = fixture(false)
    f.report()
    f.ack(f.deliver().delivery.id)
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)?.release_state).toBe(
      'not_requested'
    )
    expect(f.db.listWorkerTerminalReleaseBacklog()).toEqual([])
  })

  it.each(['succeeded', 'failed'] as const)(
    'durably requests cleanup only when the coordinator acknowledges %s',
    (outcome) => {
      f = fixture()
      f.report(outcome)
      const resource = () => f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)!
      expect(resource().release_state).toBe('not_requested')
      const delivery = f.deliver()
      expect(resource().release_state).toBe('not_requested')
      f.ack(delivery.delivery.id)
      expect(resource().release_state).toBe('requested')
      const requestedAt = resource().release_requested_at
      expect(requestedAt).toBeTruthy()
      expect(f.db.listWorkerTerminalReleaseBacklog()).toHaveLength(1)
      expect(f.ack(delivery.delivery.id).duplicate).toBe(true)
      expect(resource().release_requested_at).toBe(requestedAt)
      expect(f.db.getWorkerDispatch(f.dispatch.id)?.state).toBe(outcome)
    }
  )

  it('rejects a finite worker report while its question is unanswered', () => {
    f = fixture()
    const question = f.db.createQuestion({
      runId: f.run.id,
      dispatchId: f.dispatch.id,
      askerHandle: 'term_worker',
      question: 'Need decision?'
    })
    const result = f.db.settleWorkerReport({
      taskId: f.task.id,
      dispatchId: f.dispatch.id,
      outcome: 'succeeded',
      result: 'premature'
    })
    expect(result).toMatchObject({ action: 'rejected' })
    expect(f.db.getQuestion(question.question.message_id)?.status).toBe('pending')
    expect(f.db.getWorkerDispatch(f.dispatch.id)?.state).toBe('ready')
  })

  it.each([
    'unread mail',
    'foreign-Run unread mail',
    'active descendant',
    'separate-Run child',
    'nested-Run unread result',
    'nested-Run settled child mail'
  ] as const)('preserves accepted release intent while a worker has %s', (obligation) => {
    f = fixture()
    f.report()
    // Later Dispatch mail belongs to the next parent Delivery, so acknowledging this
    // frozen result cannot silently consume the obligation that should hold cleanup.
    const resultDelivery = f.deliver()
    if (obligation === 'unread mail' || obligation === 'foreign-Run unread mail') {
      const mailRunId =
        obligation === 'foreign-Run unread mail'
          ? f.db.createRun({
              objective: 'Foreign Run',
              coordinatorHandle: 'term_other',
              coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
            }).id
          : f.run.id
      f.db.insertMessage({
        from: 'term_coord',
        to: obligation === 'foreign-Run unread mail' ? 'term_worker' : `dispatch:${f.dispatch.id}`,
        runId: mailRunId,
        type: 'status',
        subject: 'Follow-up',
        body: 'Please inspect this.'
      })
    } else if (obligation === 'active descendant') {
      f.db.createTask({
        runId: f.run.id,
        parentId: f.task.id,
        spec: 'Still active',
        createdByPaneKey: paneKey,
        createdByProcessIncarnation: processIncarnation
      })
    } else {
      const childRun = f.db.createRun({
        objective: 'Nested Run',
        coordinatorHandle: 'term_worker',
        coordinatorPaneKey: paneKey
      })
      if (obligation === 'nested-Run unread result') {
        f.db.insertMessage({
          from: 'term_child',
          to: `run:${childRun.id}`,
          runId: childRun.id,
          type: 'worker_done',
          subject: 'Child result awaiting acceptance'
        })
      } else if (obligation === 'nested-Run settled child mail') {
        // Follow-up mail to a completed child Dispatch is readable by the nested Run's owner
        // (this worker) without changing to_handle; it must hold cleanup like Run mail does.
        const childTask = f.db.createTask({ runId: childRun.id, spec: 'Settled child' })
        const child = f.db.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskId: childTask.id,
          startOptions: { agent: 'codex' }
        }).dispatch
        f.db.db
          .prepare(`UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?`)
          .run(child.id)
        f.db.db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(childTask.id)
        f.db.insertMessage({
          from: 'term_grandchild',
          to: `dispatch:${child.id}`,
          runId: childRun.id,
          type: 'status',
          subject: 'Late follow-up for the settled child'
        })
        expect(f.db.getUndeliveredUnreadMessages(`run:${childRun.id}`)).toHaveLength(1)
      } else {
        f.db.createTask({
          runId: childRun.id,
          spec: 'Nested Run is still active',
          createdByPaneKey: paneKey,
          createdByProcessIncarnation: processIncarnation
        })
      }
    }
    f.ack(resultDelivery.delivery.id)
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)).toMatchObject({
      release_state: 'requested',
      retained_reason: null
    })
    expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(true)
    expect(f.db.listWorkerTerminalReleaseBacklog()).toHaveLength(1)
  })

  it.each(['Run mail', 'settled child mail', 'created task'])(
    'holds %s after pane breakout and clears when consumed or settled',
    (obligation) => {
      f = fixture()
      const run = f.db.createRun({
        objective: 'Nested run',
        coordinatorHandle: 'term_worker',
        coordinatorPaneKey: paneKey
      })
      const reminted = paneKey.replace('tab_worker:', 'tab_breakout:')
      f.db.db
        .prepare('UPDATE dispatch_contexts SET assignee_pane_key = ? WHERE id = ?')
        .run(reminted, f.dispatch.id)
      expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(false)
      if (obligation === 'created task') {
        const child = f.db.createTask({
          runId: run.id,
          spec: 'Still active',
          createdByPaneKey: paneKey,
          createdByProcessIncarnation: processIncarnation
        })
        expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(true)
        f.db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(child.id)
      } else {
        let recipient = `run:${run.id}`
        if (obligation === 'settled child mail') {
          const childTask = f.db.createTask({ runId: run.id, spec: 'Settled child' })
          const child = f.db.createStartingWorkerDispatch({
            creator: { kind: 'system' },
            maxDepth: Number.MAX_SAFE_INTEGER,
            taskId: childTask.id,
            startOptions: { agent: 'codex' }
          }).dispatch
          f.db.db
            .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
            .run(child.id)
          f.db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(childTask.id)
          recipient = `dispatch:${child.id}`
        }
        const mail = f.db.insertMessage({
          from: 'term_child',
          to: recipient,
          runId: run.id,
          type: 'status',
          subject: 'Unread follow-up'
        })
        expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(true)
        expect(f.db.getUndeliveredUnreadMessages(`run:${run.id}`).map((row) => row.id)).toContain(
          mail.id
        )
        f.db.markAsRead([mail.id])
      }
      expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(false)
    }
  )

  it('does not equate malformed pane keys with matching suffixes or different process incarnations', () => {
    f = fixture()
    const unrelated = f.db.createRun({
      objective: 'Unrelated',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'bad_a:same'
    })
    f.db.db
      .prepare('UPDATE dispatch_contexts SET assignee_pane_key = ? WHERE id = ?')
      .run('bad_b:same', f.dispatch.id)
    f.db.insertMessage({
      from: 'term_other',
      to: `run:${unrelated.id}`,
      runId: unrelated.id,
      subject: 'Unrelated mail'
    })
    f.db.createTask({
      runId: unrelated.id,
      spec: 'Unrelated task',
      createdByPaneKey: 'bad_a:same',
      createdByProcessIncarnation: processIncarnation
    })
    f.db.createTask({
      runId: unrelated.id,
      spec: 'Different process',
      createdByPaneKey: 'bad_b:same',
      createdByProcessIncarnation: 'different'
    })
    expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(false)
  })

  it('keeps cleanup retryable after accepted mail is read without a second acknowledgment', () => {
    f = fixture()
    f.report()
    const mail = f.db.insertMessage({
      from: 'term_coord',
      to: 'term_worker',
      runId: f.run.id,
      type: 'status',
      subject: 'Follow-up',
      body: 'Read before close.'
    })
    f.ack(f.deliver().delivery.id)
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)).toMatchObject({
      release_state: 'requested',
      retained_reason: null
    })
    expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(true)
    const requestedAt = f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)?.release_requested_at
    f.db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(mail.id)
    expect(workerHasOpenObligations(f.db, f.dispatch.id)).toBe(false)
    expect(f.db.listWorkerTerminalReleaseBacklog()).toHaveLength(1)
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)?.release_requested_at).toBe(
      requestedAt
    )
  })

  it.each(['retained', 'user_owned', 'external', 'no_owned_resource', 'federated'] as const)(
    'preserves %s terminals after acknowledgment',
    (reason) => {
      f = fixture()
      f.report()
      const resource = f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)!
      if (reason === 'retained') {
        f.db.retainWorkerTerminalResource(f.dispatch.id)
      } else if (reason === 'user_owned') {
        f.db.markWorkerTerminalUserOwned(paneKey)
      } else if (reason === 'external') {
        f.db.db
          .prepare("UPDATE worker_terminal_resources SET ownership_state = 'external' WHERE id = ?")
          .run(resource.id)
      } else if (reason === 'no_owned_resource') {
        f.db.db.prepare('DELETE FROM worker_terminal_resources WHERE id = ?').run(resource.id)
      } else {
        vi.spyOn(f.db, 'getFederatedDispatch').mockReturnValue({
          dispatch_id: f.dispatch.id
        } as never)
      }
      const before = f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)
      f.ack(f.deliver().delivery.id)
      expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)).toEqual(before)
      expect(f.db.listWorkerTerminalReleaseBacklog()).toEqual([])
    }
  )

  it.each(['retain', 'takeover'] as const)(
    'honors %s while accepted cleanup waits for mail',
    (action) => {
      f = fixture()
      f.report()
      const mail = f.db.insertMessage({
        from: 'term_coord',
        to: 'term_worker',
        runId: f.run.id,
        type: 'status',
        subject: 'Follow-up'
      })
      f.ack(f.deliver().delivery.id)
      if (action === 'retain') {
        f.db.retainWorkerTerminalResource(f.dispatch.id)
      } else {
        f.db.markWorkerTerminalUserOwned(paneKey)
      }
      f.db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(mail.id)
      expect(f.db.listWorkerTerminalReleaseBacklog()).toEqual([])
      expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)?.retained_reason).toBe(
        action === 'retain' ? 'user_requested' : 'user_takeover'
      )
    }
  )

  it.each(['succeeded', 'failed'] as const)(
    'repairs only acknowledged legacy obligation holds for %s reports',
    (outcome) => {
      f = fixture()
      f.report(outcome)
      f.ack(f.deliver().delivery.id)
      const resource = f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)!
      f.db.db
        .prepare(
          `UPDATE worker_terminal_resources SET release_state = 'retained',
             retained_reason = 'pending_obligations' WHERE id = ?`
        )
        .run(resource.id)
      expect(restoreAcceptedWorkerTerminalReleaseRequests(f.db)).toBe(1)
      expect(f.db.getWorkerTerminalResource(resource.id)).toMatchObject({
        release_state: 'requested',
        retained_reason: null,
        release_requested_at: resource.release_requested_at
      })
      expect(restoreAcceptedWorkerTerminalReleaseRequests(f.db)).toBe(0)
    }
  )

  it.each([
    'unacknowledged',
    'stale report',
    'changed process',
    'changed pane',
    'changed handle',
    'removed policy',
    'unknown archive',
    'explicit retention',
    'protection',
    'takeover'
  ] as const)('does not repair a legacy hold with %s', (reason) => {
    f = fixture()
    f.report()
    const delivery = f.deliver()
    if (reason !== 'unacknowledged') {
      f.ack(delivery.delivery.id)
    }
    const resource = f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)!
    f.db.db
      .prepare(
        `UPDATE worker_terminal_resources SET release_state = 'retained',
           retained_reason = 'pending_obligations' WHERE id = ?`
      )
      .run(resource.id)
    if (reason === 'stale report') {
      const result = JSON.parse(f.db.getTask(f.task.id)!.result!)
      f.db.db
        .prepare('UPDATE tasks SET result = ? WHERE id = ?')
        .run(JSON.stringify({ ...result, messageId: 'different-report' }), f.task.id)
    } else if (reason === 'removed policy') {
      f.db.db
        .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
        .run(JSON.stringify({ agent: 'codex' }), f.dispatch.id)
    } else if (reason === 'unknown archive') {
      f.db.storeWorkerTerminalArchive({
        dispatchId: f.dispatch.id,
        resourceId: resource.id,
        kind: 'terminal_tail',
        content: '{}'
      })
    } else if (reason === 'takeover') {
      f.db.markWorkerTerminalUserOwned(paneKey)
    } else if (reason === 'explicit retention' || reason === 'protection') {
      f.db.db
        .prepare('UPDATE worker_terminal_resources SET retained_reason = ? WHERE id = ?')
        .run(reason === 'protection' ? 'protection_held' : 'user_requested', resource.id)
    } else if (reason !== 'unacknowledged') {
      const column = {
        'changed process': 'process_incarnation',
        'changed pane': 'pane_key',
        'changed handle': 'terminal_handle'
      }[reason]
      f.db.db
        .prepare(`UPDATE worker_terminal_resources SET ${column} = 'different' WHERE id = ?`)
        .run(resource.id)
    }
    const before = f.db.getWorkerTerminalResource(resource.id)
    expect(restoreAcceptedWorkerTerminalReleaseRequests(f.db)).toBe(0)
    expect(f.db.getWorkerTerminalResource(resource.id)).toEqual(before)
    expect(f.db.listWorkerTerminalReleaseBacklog()).toEqual([])
  })

  it('leaves the exact terminal with the next Dispatch after immediate reuse', () => {
    f = fixture()
    f.report()
    const delivery = f.deliver()
    const next = f.start('external')
    f.ack(delivery.delivery.id)
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)).toBeUndefined()
    expect(f.db.getWorkerTerminalResourceByOwner(next.dispatch.id)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    expect(f.db.listWorkerTerminalReleaseBacklog()).toEqual([])
  })

  it('does not turn a rejected or merely reported completion into release authority', () => {
    f = fixture()
    const message = f.db.insertMessage({
      from: 'term_other',
      to: `run:${f.run.id}`,
      runId: f.run.id,
      type: 'worker_done',
      subject: 'Unaccepted report',
      payload: JSON.stringify({
        taskId: f.task.id,
        dispatchId: f.dispatch.id,
        outcome: 'succeeded'
      })
    })
    expect(reconcileLifecycleMessage(f.db, message).action).toBe('rejected')
    f.ack(f.deliver().delivery.id)
    expect(f.db.listWorkerTerminalReleaseBacklog()).toEqual([])
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)?.release_state).toBe(
      'not_requested'
    )
  })

  it('rolls back acknowledgment and cleanup when the coordinator has been replaced', () => {
    f = fixture()
    f.report()
    const delivery = f.deliver()
    f.db.bindRun({
      runId: f.run.id,
      coordinatorHandle: 'term_new',
      coordinatorPaneKey: 'tab_new:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    expect(() => f.ack(delivery.delivery.id)).toThrow(/replaced|fenced/)
    expect(f.db.getWorkerTerminalResourceByOwner(f.dispatch.id)?.release_state).toBe(
      'not_requested'
    )
  })
})
