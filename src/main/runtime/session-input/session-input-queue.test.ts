import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSessionInputProgram,
  type SessionInputSubmission
} from '../../../shared/session-input-program'
import { SessionInputQueue } from './session-input-queue'

type Written = { ptyId: string; data: string }

function createQueue(options: { write?: (ptyId: string, data: string) => boolean } = {}): {
  queue: SessionInputQueue
  writes: Written[]
} {
  const writes: Written[] = []
  const queue = new SessionInputQueue({
    write: (ptyId, data) => {
      writes.push({ ptyId, data })
      return options.write ? options.write(ptyId, data) : true
    }
  })
  return { queue, writes }
}

function submission(overrides: Partial<SessionInputSubmission> = {}): SessionInputSubmission {
  const body = overrides.body ?? 'ship it'
  return {
    ptyId: overrides.ptyId ?? 'pty-1',
    clientMessageId: overrides.clientMessageId ?? 'msg-1',
    origin: overrides.origin ?? 'chat',
    body,
    ...(overrides.force !== undefined ? { force: overrides.force } : {}),
    program:
      overrides.program ??
      buildSessionInputProgram({
        clearInput: '\x15',
        body: `[body]${body}`,
        submitDelayMs: 500,
        submit: '\r'
      })
  }
}

describe('SessionInputQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers one item as clear, body and submit in order', async () => {
    const { queue, writes } = createQueue()
    const receipt = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(receipt).resolves.toMatchObject({ status: 'delivered', clientMessageId: 'msg-1' })
    expect(writes.map((write) => write.data)).toEqual(['\x15', '[body]ship it', '\r'])
  })

  it('holds the submit keystroke for the requested gap', async () => {
    const { queue, writes } = createQueue()
    void queue.submit(submission())
    await vi.advanceTimersByTimeAsync(200)
    expect(writes.map((write) => write.data)).toEqual(['\x15', '[body]ship it'])
    await vi.advanceTimersByTimeAsync(400)
    expect(writes.map((write) => write.data)).toEqual(['\x15', '[body]ship it', '\r'])
  })

  // Two Enters inside the 500 ms submit window carry the same clientMessageId.
  it('delivers once when the same clientMessageId is submitted twice inside the submit window', async () => {
    const { queue, writes } = createQueue()
    const first = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(50)
    const second = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'delivered' })
    await expect(second).resolves.toMatchObject({ status: 'already-delivered' })
    expect(writes.filter((write) => write.data === '\r')).toHaveLength(1)
    expect(writes.filter((write) => write.data === '[body]ship it')).toHaveLength(1)
  })

  it('replays a settled clientMessageId as already-delivered without writing again', async () => {
    const { queue, writes } = createQueue()
    await vi.advanceTimersByTimeAsync(0)
    const first = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'delivered' })
    const writeCount = writes.length
    const replay = await queue.submit(submission())
    expect(replay.status).toBe('already-delivered')
    expect(writes).toHaveLength(writeCount)
  })

  it('rejects an identical body from the same origin inside the duplicate window unless forced', async () => {
    const { queue, writes } = createQueue()
    const first = queue.submit(submission({ clientMessageId: 'msg-a' }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'delivered' })

    const duplicate = await queue.submit(submission({ clientMessageId: 'msg-b' }))
    expect(duplicate.status).toBe('duplicate-rejected')
    expect(writes.filter((write) => write.data === '[body]ship it')).toHaveLength(1)

    const forced = queue.submit(submission({ clientMessageId: 'msg-c', force: true }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(forced).resolves.toMatchObject({ status: 'delivered' })
    expect(writes.filter((write) => write.data === '[body]ship it')).toHaveLength(2)
  })

  it('accepts the same body again once the duplicate window has passed', async () => {
    const { queue, writes } = createQueue()
    const first = queue.submit(submission({ clientMessageId: 'msg-a' }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'delivered' })
    await vi.advanceTimersByTimeAsync(2100)
    const again = queue.submit(submission({ clientMessageId: 'msg-b' }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(again).resolves.toMatchObject({ status: 'delivered' })
    expect(writes.filter((write) => write.data === '[body]ship it')).toHaveLength(2)
  })

  it('lets the same body through from a different origin inside the window', async () => {
    const { queue } = createQueue()
    const first = queue.submit(submission({ clientMessageId: 'msg-a', origin: 'chat' }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'delivered' })
    const other = queue.submit(submission({ clientMessageId: 'msg-b', origin: 'chain' }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(other).resolves.toMatchObject({ status: 'delivered' })
  })

  it('writes zero bytes to the old target after a rebind and reports cancelled', async () => {
    const { queue, writes } = createQueue()
    const inFlight = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(50)
    expect(writes.map((write) => write.data)).toEqual(['\x15', '[body]ship it'])
    queue.cancelSession('pty-1', 'rebound')
    const writesAtCancel = writes.length
    await vi.advanceTimersByTimeAsync(5000)
    await expect(inFlight).resolves.toMatchObject({ status: 'cancelled', reason: 'rebound' })
    expect(writes).toHaveLength(writesAtCancel)
    expect(writes.some((write) => write.data === '\r')).toBe(false)
  })

  it('cancels items still waiting for their turn without writing any bytes', async () => {
    const { queue, writes } = createQueue()
    const first = queue.submit(submission({ clientMessageId: 'msg-1' }))
    const queued = queue.submit(
      submission({ clientMessageId: 'msg-2', body: 'second', force: true })
    )
    await vi.advanceTimersByTimeAsync(50)
    queue.cancelSession('pty-1', 'session-exited')
    await vi.advanceTimersByTimeAsync(5000)
    await expect(first).resolves.toMatchObject({ status: 'cancelled' })
    await expect(queued).resolves.toMatchObject({ status: 'cancelled' })
    expect(writes.some((write) => write.data === 'second')).toBe(false)
    expect(writes.some((write) => write.data === '\r')).toBe(false)
  })

  it('does not cancel a different session', async () => {
    const { queue, writes } = createQueue()
    const other = queue.submit(submission({ ptyId: 'pty-2', clientMessageId: 'msg-2' }))
    queue.cancelSession('pty-1', 'rebound')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(other).resolves.toMatchObject({ status: 'delivered' })
    expect(writes.every((write) => write.ptyId === 'pty-2')).toBe(true)
  })

  it('serializes chat, chain and worker items on one session without interleaving bytes', async () => {
    const order: string[] = []
    const queueWithTrace = new SessionInputQueue({
      write: (ptyId, data) => {
        order.push(`${ptyId}:${data}`)
        return true
      }
    })
    void queueWithTrace.submit(
      submission({
        clientMessageId: 'chat-1',
        origin: 'chat',
        body: 'chat body',
        program: buildSessionInputProgram({
          clearInput: 'chat-clear',
          body: 'chat-body',
          submitDelayMs: 500,
          submit: 'chat-enter'
        })
      })
    )
    void queueWithTrace.submit(
      submission({
        clientMessageId: 'chain-1',
        origin: 'chain',
        body: 'chain body',
        program: buildSessionInputProgram({
          body: 'chain-body',
          submitDelayMs: 50,
          submit: 'chain-enter'
        })
      })
    )
    const workerDone = queueWithTrace.runExclusive(
      { ptyId: 'pty-1', origin: 'worker' },
      async (ctx) => {
        await ctx.write('worker-body')
        await ctx.pause(20)
        await ctx.write('worker-enter')
        return 'ok'
      }
    )
    await vi.advanceTimersByTimeAsync(5000)
    await expect(workerDone).resolves.toBe('ok')
    expect(order).toEqual([
      'pty-1:chat-clear',
      'pty-1:chat-body',
      'pty-1:chat-enter',
      'pty-1:chain-body',
      'pty-1:chain-enter',
      'pty-1:worker-body',
      'pty-1:worker-enter'
    ])
  })

  it('reports a refused write as failed and keeps the session usable', async () => {
    const writes: Written[] = []
    const queue = new SessionInputQueue({
      write: (ptyId, data) => {
        writes.push({ ptyId, data })
        return data !== '[body]ship it'
      }
    })
    const failed = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(failed).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'terminal_not_writable'
    })
    expect(writes.some((write) => write.data === '\r')).toBe(false)

    const next = queue.submit(submission({ clientMessageId: 'msg-2', body: 'other' }))
    await vi.advanceTimersByTimeAsync(1000)
    await expect(next).resolves.toMatchObject({ status: 'delivered' })
  })

  it('keeps the original failure classification from a delivery', async () => {
    const queue = new SessionInputQueue({ write: () => true })
    const failed = queue.runExclusive({ ptyId: 'pty-1', origin: 'worker' }, async () => {
      throw new Error('agent_prompt_stalled')
    })
    const stalled = expect(failed).rejects.toThrow('agent_prompt_stalled')
    await vi.advanceTimersByTimeAsync(10)
    await stalled
    const receipt = await queue.submit(
      submission({
        clientMessageId: 'msg-stall',
        program: buildSessionInputProgram({ body: 'x', submitDelayMs: 0, submit: '' })
      })
    )
    expect(receipt.status).toBe('delivered')
  })

  it('does not replay a failed clientMessageId as already-delivered', async () => {
    let allow = false
    const writes: Written[] = []
    const queue = new SessionInputQueue({
      write: (ptyId, data) => {
        writes.push({ ptyId, data })
        return allow
      }
    })
    const first = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(first).resolves.toMatchObject({ status: 'failed' })
    allow = true
    const retry = queue.submit(submission())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(retry).resolves.toMatchObject({ status: 'delivered' })
  })

  it('aborts a worker delivery when the session rebinds', async () => {
    const queue = new SessionInputQueue({ write: () => true })
    const aborted: boolean[] = []
    const running = queue.runExclusive({ ptyId: 'pty-1', origin: 'worker' }, async (ctx) => {
      await ctx.pause(10_000)
      aborted.push(ctx.signal.aborted)
      return 'done'
    })
    const cancelled = expect(running).rejects.toThrow('session_input_cancelled')
    await vi.advanceTimersByTimeAsync(10)
    queue.cancelSession('pty-1', 'rebound')
    await vi.advanceTimersByTimeAsync(20_000)
    await cancelled
    expect(aborted).toEqual([])
  })

  it('refuses a program the host will not execute', async () => {
    const { queue, writes } = createQueue()
    const receipt = await queue.submit(submission({ program: { steps: [] } }))
    expect(receipt).toMatchObject({ status: 'failed', errorCode: 'session_input_program_empty' })
    expect(writes).toHaveLength(0)
  })

  it('widens an unobserved clear before writing the body', async () => {
    const { queue, writes } = createQueue()
    const receipt = queue.submit(
      submission({
        program: buildSessionInputProgram({
          clearInput: '\x15',
          clearConfirm: { afterMs: 140, widenTo: 'WIDE' },
          body: '[body]ship it',
          submitDelayMs: 500,
          submit: '\r'
        })
      })
    )
    await vi.advanceTimersByTimeAsync(2000)
    await expect(receipt).resolves.toMatchObject({ status: 'delivered' })
    expect(writes.map((write) => write.data)).toEqual(['\x15', 'WIDE', '[body]ship it', '\r'])
  })

  it('reports idle only once every item for the session has settled', async () => {
    const { queue } = createQueue()
    expect(queue.isIdle('pty-1')).toBe(true)
    const inFlight = queue.submit(submission())
    expect(queue.isIdle('pty-1')).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await inFlight
    expect(queue.isIdle('pty-1')).toBe(true)
  })
})
