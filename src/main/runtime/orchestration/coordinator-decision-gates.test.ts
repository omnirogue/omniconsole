import { afterEach, describe, expect, it } from 'vitest'
import {
  openDecisionGateFromMessage,
  reblockTasksWithPendingGates
} from './coordinator-decision-gates'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

describe('coordinator decision-gate authority', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('opens a gate only for the sender-owned active Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'owned gate target' })
    const dispatch = createRootDispatch(db, task.id, 'term_owner', 'tab_owner:leaf_owner')
    const logs: string[] = []

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: 'term_owner',
        to: 'term_coordinator',
        subject: 'Need approval',
        type: 'decision_gate',
        senderPaneKey: 'tab_owner:leaf_owner',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          question: 'Proceed?'
        })
      }),
      (message) => logs.push(message)
    )

    expect(db.listGates({ taskId: task.id })).toHaveLength(1)
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(logs.at(-1)).toBe(`Task ${task.id} blocked on decision gate`)
  })

  it('rejects a gate targeting another active Dispatch without mutating either Task', () => {
    db = new OrchestrationDb(':memory:')
    const attackerTask = db.createTask({ spec: 'attacker assignment' })
    const attacker = createRootDispatch(
      db,
      attackerTask.id,
      'term_attacker',
      'tab_attacker:leaf_attacker'
    )
    const victimTask = db.createTask({ spec: 'victim assignment' })
    const victim = createRootDispatch(db, victimTask.id, 'term_victim', 'tab_victim:leaf_victim')
    const logs: string[] = []

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: 'term_attacker',
        to: 'term_coordinator',
        subject: 'Block the victim',
        type: 'decision_gate',
        senderPaneKey: 'tab_attacker:leaf_attacker',
        payload: JSON.stringify({
          taskId: victimTask.id,
          dispatchId: attacker.id,
          question: 'Stop?'
        })
      }),
      (message) => logs.push(message)
    )

    expect(db.listGates({ taskId: victimTask.id })).toHaveLength(0)
    expect(db.getTask(attackerTask.id)?.status).toBe('dispatched')
    expect(db.getTask(victimTask.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(attacker.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(victim.id)?.status).toBe('dispatched')
    expect(logs.at(-1)).toContain('Rejected decision gate from term_attacker')
  })

  it('accepts the canonical sender of an imported federated Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'remote gate target' })
    const dispatch = createRootDispatch(db, task.id, 'remote-worker')

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: `dispatch:${dispatch.id}`,
        to: 'term_coordinator',
        subject: 'Remote approval required',
        type: 'decision_gate',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          question: 'Proceed remotely?'
        })
      }),
      () => {}
    )

    expect(db.listGates({ taskId: task.id })).toHaveLength(1)
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })

  it('logs the omnios route for a bound business gate without crashing the coordinator', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'Customer response approval' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.db.prepare('UPDATE tasks SET hub_task_id = ? WHERE id = ?').run('btk_customer', task.id)
    const logs: string[] = []

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: 'term_worker',
        to: 'term_coordinator',
        subject: 'Approve reply',
        type: 'decision_gate',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          question: 'Send this customer reply?'
        })
      }),
      (message) => logs.push(message)
    )

    expect(logs.at(-1)).toContain('https://app.omnisi.ai')
    expect(db.listGates()).toEqual([])
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('reblocks only explicit execution gates after their tasks are bound', () => {
    db = new OrchestrationDb(':memory:')
    const legacy = db.createTask({ spec: 'Legacy business decision' })
    const execution = db.createTask({ spec: 'Worker step question' })
    db.createGate({ taskId: legacy.id, question: 'Publish?' })
    db.createGate({
      taskId: execution.id,
      question: 'Which renderer is installed?',
      decisionScope: 'execution'
    })
    db.db.prepare("UPDATE tasks SET hub_task_id = ?, status = 'ready'").run('btk_bound')

    reblockTasksWithPendingGates(db)

    expect(db.getTask(legacy.id)?.status).toBe('ready')
    expect(db.getTask(execution.id)).toMatchObject({
      status: 'blocked',
      hub_task_id: 'btk_bound'
    })
  })
})
