import { describe, expect, it } from 'vitest'
import { createWorkflowProgramContext } from './workflow-program-context'
import { WorkflowScriptSlots } from './workflow-script-slots'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((open) => {
    resolve = open
  })
  return { promise, resolve }
}

describe('trusted grouping primitives', () => {
  it('settles paid siblings before surfacing a fatal error', async () => {
    const fatal = new Error('ownership lost')
    const sibling = gate()
    let settled = false
    let siblingAccepted = false
    const context = createWorkflowProgramContext({
      agent: async () => null,
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: (error) => error === fatal
    })
    const group = context
      .parallel([
        async () => {
          throw fatal
        },
        async () => {
          await sibling.promise
          siblingAccepted = true
          return 'accepted'
        }
      ])
      .finally(() => {
        settled = true
      })
    const assertion = expect(group).rejects.toThrow('ownership lost')
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    sibling.resolve()
    await assertion
    expect(siblingAccepted).toBe(true)
  })
  it('uses capacity only for agent calls through nested pipeline and parallel', async () => {
    const slots = new WorkflowScriptSlots(1)
    let calls = 0
    const context = createWorkflowProgramContext({
      agent: async () => slots.run(async () => ++calls),
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    const output = await context.pipeline([1, 2], async () =>
      context.parallel([
        () =>
          context.agent({
            id: 'fixture',
            seatId: 'fixture',
            prompt: 'fixture',
            schema: {},
            dependencies: [],
            validateSemantics: () => null
          })
      ])
    )
    expect(output).toEqual([[1], [2]])
    expect(slots.running).toBe(0)
  })
  it('retains ordinary sibling results when one child fails', async () => {
    const context = createWorkflowProgramContext({
      agent: async () => null,
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    expect(
      await context.parallel([
        async () => {
          throw new Error('provider error')
        },
        async () => 'accepted'
      ])
    ).toEqual([null, 'accepted'])
  })
})
