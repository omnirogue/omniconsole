import { describe, expect, it } from 'vitest'
import { WorkflowScriptSlots } from './workflow-script-slots'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('workflow slot admission', () => {
  it('removes an aborted waiter immediately without releasing a running sibling', async () => {
    const slots = new WorkflowScriptSlots(1)
    const held = deferred()
    const first = slots.run(() => held.promise)
    const controller = new AbortController()
    let launched = false
    const queued = slots.run(async () => {
      launched = true
    }, controller.signal)
    const rejected = expect(queued).rejects.toThrow('stop')
    expect(slots.queued).toBe(1)
    controller.abort(new Error('stop'))
    await rejected
    expect(slots.queued).toBe(0)
    expect(slots.running).toBe(1)
    held.resolve()
    await first
    expect(launched).toBe(false)
    expect(slots.running).toBe(0)
  })

  it('holds a running slot until its actual work settles after cancellation', async () => {
    const slots = new WorkflowScriptSlots(1)
    const started = deferred()
    const held = deferred()
    const controller = new AbortController()
    const first = slots.run(async () => {
      started.resolve()
      await held.promise
    }, controller.signal)
    await started.promise
    controller.abort()
    let secondStarted = false
    const second = slots.run(async () => {
      secondStarted = true
    })
    expect(slots.running).toBe(1)
    expect(secondStarted).toBe(false)
    held.resolve()
    await Promise.all([first, second])
    expect(secondStarted).toBe(true)
    expect(slots.running).toBe(0)
  })

  it('preserves FIFO and the cap under interleaved newcomers and queued grants', async () => {
    const slots = new WorkflowScriptSlots(1)
    const order: number[] = []
    let running = 0
    let highWater = 0
    const run = (id: number) =>
      slots.run(async () => {
        running++
        highWater = Math.max(highWater, running)
        order.push(id)
        await Promise.resolve()
        running--
      })
    const first = run(0)
    const second = run(1)
    const third = first.then(() => run(2))
    await Promise.all([first, second, third])
    expect(order).toEqual([0, 1, 2])
    expect(highWater).toBe(1)
    expect(slots.running).toBe(0)
  })

  it('rejects cancellation between grant and callback without leaking capacity', async () => {
    const slots = new WorkflowScriptSlots(1)
    const controller = new AbortController()
    let launched = false
    const call = slots.run(async () => {
      launched = true
    }, controller.signal)
    controller.abort(new Error('cancel before callback'))
    await expect(call).rejects.toThrow('cancel before callback')
    expect(launched).toBe(false)
    expect(slots.running).toBe(0)
    await expect(slots.run(async () => 'next')).resolves.toBe('next')
  })

  it('does not enqueue a pre-aborted call', async () => {
    const slots = new WorkflowScriptSlots(1)
    const controller = new AbortController()
    controller.abort(new Error('already stopped'))
    await expect(slots.run(async () => 'wrong', controller.signal)).rejects.toThrow(
      'already stopped'
    )
    expect(slots.running).toBe(0)
    expect(slots.queued).toBe(0)
  })
})
