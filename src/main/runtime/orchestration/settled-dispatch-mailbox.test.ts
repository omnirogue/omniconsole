import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { notifySettledDispatchMailbox } from './settled-dispatch-mailbox'

describe('settled Dispatch mail in the parent Run mailbox', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  function fixture() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Parent owns the handoff',
      coordinatorHandle: 'term_parent',
      coordinatorPaneKey: 'tab_parent:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'Finite worker', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const address = `dispatch:${dispatch.id}`
    const consumer = { runId: run.id, consumerGeneration: run.consumer_generation }
    return { run, task, dispatch, address, consumer }
  }

  it.each(['completed', 'failed'] as const)(
    'recovers queued mail after %s without another worker check or recipient rewrite',
    (status) => {
      const f = fixture()
      const runtime = { notifyMessageArrived: vi.fn() }
      const message = db.insertMessage({
        runId: f.run.id,
        from: 'term_parent',
        to: f.address,
        subject: 'Please include the validation result',
        body: 'This arrived while you were working.',
        type: 'status',
        threadId: 'thread_original',
        payload: JSON.stringify({ source: 'parent', taskId: f.task.id })
      })
      const parentAddress = `run:${f.run.id}`
      expect(db.getUnreadRunMailbox(f.run.id)).toEqual([])
      expect(db.getOrCreateRunDelivery(f.consumer)).toBeUndefined()
      expect(db.getUndeliveredUnreadMessages(parentAddress)).toEqual([])
      notifySettledDispatchMailbox(runtime, db, f.dispatch.id)
      expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()

      if (status === 'completed') {
        db.completeDispatch(f.dispatch.id)
      } else {
        db.failDispatch(f.dispatch.id, 'Provider exited')
      }
      notifySettledDispatchMailbox(runtime, db, f.dispatch.id)
      expect(runtime.notifyMessageArrived).toHaveBeenCalledExactlyOnceWith(parentAddress, 'status')
      expect(db.getUnreadRunMailbox(f.run.id, 10, ['status'])).toEqual([message])
      expect(db.getUndeliveredUnreadMessages(parentAddress)).toEqual([message])
      expect(db.getUndeliveredUnreadMailboxHandles()).toEqual([parentAddress])
      expect(db.areUnreadMessages(parentAddress, [message.id])).toBe(true)
      const delivery = db.getOrCreateRunDelivery({ ...f.consumer, wakeTypes: ['status'] })!
      expect(delivery.messages).toEqual([message])
      expect(db.getOrCreateRunDelivery(f.consumer)?.delivery.id).toBe(delivery.delivery.id)
      expect(db.getUnreadMessages(f.address)).toEqual([message])

      db.acknowledgeRunDelivery({ ...f.consumer, deliveryId: delivery.delivery.id })
      expect(db.getUnreadMessages(f.address)).toEqual([])
      expect(db.areUnreadMessages(parentAddress, [message.id])).toBe(false)
      expect(db.getRunMailboxHistory(f.run.id, 10, ['status'])).toEqual([{ ...message, read: 1 }])
      expect(db.getMessageById(message.id)).toEqual({ ...message, read: 1 })
    }
  )

  it('keeps active, foreign-Run, and mismatched Dispatch mail out of parent deliveries', () => {
    const f = fixture()
    const foreign = db.createRun({
      objective: 'Other parent',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:33333333-3333-4333-9333-333333333333'
    })
    const activeTask = db.createTask({ spec: 'Still working', runId: f.run.id })
    const active = createRootDispatch(db, activeTask.id, 'term_active')
    const foreignTask = db.createTask({ spec: 'Other work', runId: foreign.id })
    const foreignDispatch = createRootDispatch(db, foreignTask.id, 'term_foreign')
    for (const [runId, dispatchId] of [
      [f.run.id, active.id],
      [foreign.id, foreignDispatch.id],
      [foreign.id, f.dispatch.id]
    ]) {
      db.insertMessage({ runId, from: 'sender', to: `dispatch:${dispatchId}`, subject: 'Private' })
    }
    db.completeDispatch(f.dispatch.id)
    db.completeDispatch(foreignDispatch.id)
    expect(db.getUnreadRunMailbox(f.run.id)).toEqual([])
    expect(db.getOrCreateRunDelivery(f.consumer)).toBeUndefined()
    expect(db.getUndeliveredUnreadMessages(`run:${f.run.id}`)).toEqual([])
    expect(db.getUnreadRunMailbox(foreign.id)).toEqual([
      expect.objectContaining({ to_handle: `dispatch:${foreignDispatch.id}` })
    ])
    expect(db.getUnreadMessages(`dispatch:${active.id}`)).toHaveLength(1)
    const runtime = { notifyMessageArrived: vi.fn() }
    notifySettledDispatchMailbox(runtime, db, f.dispatch.id)
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })

  it('replays a bounded settled-mail delivery and fences stale parent acknowledgments', () => {
    const f = fixture()
    for (let index = 0; index < 51; index += 1) {
      db.insertMessage({ runId: f.run.id, from: 'sender', to: f.address, subject: `Mail ${index}` })
    }
    db.completeDispatch(f.dispatch.id)
    const first = db.getOrCreateRunDelivery(f.consumer)!
    expect(first.messages).toHaveLength(50)
    const rebound = db.bindRun({
      runId: f.run.id,
      coordinatorHandle: 'term_replacement',
      coordinatorPaneKey: 'tab_new:22222222-2222-4222-9222-222222222222'
    })!
    expect(() =>
      db.acknowledgeRunDelivery({ ...f.consumer, deliveryId: first.delivery.id })
    ).toThrow(/consumer|fenced/i)
    expect(db.getUnreadMessages(f.address)).toHaveLength(51)
    const consumer = { runId: f.run.id, consumerGeneration: rebound.consumer_generation }
    const replacement = db.getOrCreateRunDelivery(consumer)!
    expect(replacement.messages).toEqual(first.messages)
    expect(replacement.delivery.id).not.toBe(first.delivery.id)
    db.acknowledgeRunDelivery({ ...consumer, deliveryId: replacement.delivery.id })
    expect(db.getUnreadMessages(f.address)).toEqual([
      expect.objectContaining({ subject: 'Mail 50', to_handle: f.address })
    ])
    const next = db.getOrCreateRunDelivery(consumer)!
    db.acknowledgeRunDelivery({ ...consumer, deliveryId: next.delivery.id })
    expect(db.getUnreadMessages(f.address)).toEqual([])
  })

  it('acknowledges mail without answering pending questions or deciding gates', () => {
    const f = fixture()
    const question = db.createQuestion({
      runId: f.run.id,
      dispatchId: f.dispatch.id,
      askerHandle: 'term_worker',
      question: 'Which result needs human approval?'
    })
    db.insertMessage({
      runId: f.run.id,
      from: 'term_parent',
      to: f.address,
      subject: 'Question context',
      type: 'question',
      threadId: question.message.id
    })
    const gate = db.createGate({ taskId: f.task.id, question: 'Approve the next step?' })
    const delivery = db.getOrCreateRunDelivery({ ...f.consumer, wakeTypes: ['question'] })!
    expect(delivery.messages).toHaveLength(2)
    db.acknowledgeRunDelivery({ ...f.consumer, deliveryId: delivery.delivery.id })
    expect(db.getUnreadMessages(f.address)).toEqual([])
    expect(db.getQuestion(question.message.id)?.status).toBe('pending')
    expect(db.getGate(gate.id)?.status).toBe('pending')
    expect(db.getTask(f.task.id)?.status).toBe('blocked')
  })
})
