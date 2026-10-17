import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import { createRootDispatch } from '../../orchestration/db/root-dispatch-test-fixture'
import { workerHasOpenObligations } from '../../orchestration/db/worker-terminal/worker-terminal-accepted-release'
import * as mailbox from '../../orchestration/settled-dispatch-mailbox'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

// Why: the owned cleanup hold counts unread rows addressed to a Dispatch/Run mailbox. Only the
// mailbox consumer's acknowledgment may clear them; a direct check or a reply must not.
describe('Run and Dispatch mailbox rows stay unread outside their consumer', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let activeRunId: string | undefined

  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })

  function setup(): void {
    ;({ db, ctx, activeRunId } = h.setup())
  }

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  function readFlag(id: string): number {
    return (db.db.prepare('SELECT read FROM messages WHERE id = ?').get(id) as { read: number })
      .read
  }

  function settledDispatchWithMail(): { dispatchId: string; messageId: string } {
    const task = db.createTask({ spec: 'worker that already reported' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.db
      .prepare(`INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle)
                VALUES (?, 'succeeded', 'settled', 'term_worker')`)
      .run(dispatch.id)
    const message = db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Follow-up before cleanup'
    })
    db.completeDispatch(dispatch.id)
    expect(workerHasOpenObligations(db, dispatch.id)).toBe(true)
    return { dispatchId: dispatch.id, messageId: message.id }
  }

  it('returns committed completion when settled mailbox notification throws', async () => {
    setup()
    const task = db.createTask({ spec: 'notification failure' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    vi.spyOn(mailbox, 'notifySettledDispatchMailbox').mockImplementationOnce(() => {
      throw new Error('mailbox unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(ctx.runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const result = await call('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
    })
    expect(result).toMatchObject({
      lifecycle: { action: 'completed' },
      message: { type: 'worker_done' }
    })
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(warn).toHaveBeenCalledWith(
      '[orchestration] could not notify settled Dispatch mailbox',
      dispatch.id,
      expect.any(Error)
    )
  })

  it('check against a settled Dispatch address is inspect-only and keeps the cleanup hold', async () => {
    setup()
    const { dispatchId, messageId } = settledDispatchWithMail()

    const result = (await call('orchestration.check', { terminal: `dispatch:${dispatchId}` })) as {
      count: number
    }

    expect(result.count).toBe(1)
    expect(readFlag(messageId)).toBe(0)
    expect(workerHasOpenObligations(db, dispatchId)).toBe(true)
  })

  it('check against a Run address never marks the Run mailbox read', async () => {
    setup()
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'status for the coordinator'
    })

    await call('orchestration.check', { terminal: `run:${activeRunId}` })

    expect(readFlag(message.id)).toBe(0)
  })

  it('reply to Dispatch mail leaves the original unread for the owner', async () => {
    setup()
    const { dispatchId, messageId } = settledDispatchWithMail()

    await call('orchestration.reply', { id: messageId, from: 'term_worker', body: 'seen' })

    expect(readFlag(messageId)).toBe(0)
    expect(workerHasOpenObligations(db, dispatchId)).toBe(true)
  })

  it('reply to Run mail leaves the original unread for the consumer', async () => {
    setup()
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'status for the coordinator'
    })

    await call('orchestration.reply', { id: message.id, from: 'term_coord', body: 'thanks' })

    expect(readFlag(message.id)).toBe(0)
  })

  it('reply to direct terminal mail still marks the original read', async () => {
    setup()
    const message = db.insertMessage({
      from: 'term_coord',
      to: 'term_worker',
      subject: 'direct note'
    })

    await call('orchestration.reply', { id: message.id, from: 'term_worker', body: 'ack' })

    expect(readFlag(message.id)).toBe(1)
  })
})
