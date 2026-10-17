import { describe, expect, it } from 'vitest'
import { createLiveWorkflowAgent } from './workflow-execution-live'
import type { WorkflowProgramCall } from './workflow-program-context'
import { WorkflowScriptSlots } from './workflow-script-slots'

function call(id: string, seatId = 'seat-1'): WorkflowProgramCall {
  return {
    id,
    seatId,
    prompt: 'Question',
    schema: { type: 'object', properties: {} },
    dependencies: [],
    validateSemantics: () => null
  }
}

function harness(fail = false) {
  const events: string[] = []
  const pool = new WorkflowScriptSlots(1)
  const releases: (() => void)[] = []
  const agent = createLiveWorkflowAgent({
    executionId: 'run-1',
    live: {
      queued: (id, callId, seatId) => events.push(`queued ${id} ${callId} ${seatId}`),
      acquired: (id, callId) => events.push(`acquired ${id} ${callId}`),
      settled: (id, callId) => events.push(`settled ${id} ${callId}`)
    },
    slots: (onAcquired) => ({
      run: (work, signal) =>
        pool.run(() => {
          onAcquired?.()
          return work()
        }, signal)
    }),
    create: (slots) => async (entry) =>
      slots.run(async () => {
        await new Promise<void>((resolve) => releases.push(resolve))
        if (fail) {
          throw new Error(`${entry.id} failed`)
        }
        return entry.id
      })
  })
  return { events, agent, releases }
}

describe('live workflow agent hooks', () => {
  it('reports a slot wait separately from starting and settles after durable state answers', async () => {
    const h = harness()
    const first = h.agent(call('answer/seat-1'))
    const second = h.agent(call('answer/seat-2', 'seat-2'))
    await waitForRelease(h.releases)
    // One slot: the second call is still waiting while the first holds it.
    expect(h.events).toEqual([
      'queued run-1 answer/seat-1 seat-1',
      'queued run-1 answer/seat-2 seat-2',
      'acquired run-1 answer/seat-1'
    ])
    h.releases.shift()!()
    expect(await first).toBe('answer/seat-1')
    await waitForRelease(h.releases)
    h.releases.shift()!()
    expect(await second).toBe('answer/seat-2')
    const at = (event: string) => h.events.indexOf(event)
    expect([...h.events].sort()).toEqual([
      'acquired run-1 answer/seat-1',
      'acquired run-1 answer/seat-2',
      'queued run-1 answer/seat-1 seat-1',
      'queued run-1 answer/seat-2 seat-2',
      'settled run-1 answer/seat-1',
      'settled run-1 answer/seat-2'
    ])
    expect(at('settled run-1 answer/seat-1')).toBeGreaterThan(at('acquired run-1 answer/seat-1'))
    expect(at('acquired run-1 answer/seat-2')).toBeGreaterThan(at('acquired run-1 answer/seat-1'))
    expect(at('settled run-1 answer/seat-2')).toBeGreaterThan(at('acquired run-1 answer/seat-2'))
  })

  it('settles a call whose durable agent rejects', async () => {
    const h = harness(true)
    const pending = h.agent(call('chair/final'))
    await waitForRelease(h.releases)
    h.releases.shift()!()
    await expect(pending).rejects.toThrow('chair/final failed')
    expect(h.events.at(-1)).toBe('settled run-1 chair/final')
  })

  it('is exactly the durable agent when no live hooks are installed', async () => {
    let acquired = false
    const agent = createLiveWorkflowAgent({
      executionId: 'run-1',
      slots: (onAcquired) => {
        acquired = onAcquired !== undefined
        return { run: (work) => work() }
      },
      create: (slots) => (entry) => slots.run(async () => entry.id)
    })
    expect(await agent(call('answer/seat-1'))).toBe('answer/seat-1')
    expect(acquired).toBe(false)
  })
})

/** Waits until the slot holder has registered its release, without fake timers. */
async function waitForRelease(releases: (() => void)[]): Promise<void> {
  for (let tick = 0; tick < 100 && releases.length === 0; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (!releases.length) {
    throw new Error('The slot was never granted')
  }
}
