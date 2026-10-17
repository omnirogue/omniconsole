import { describe, expect, it } from 'vitest'
import { WorkerUnitRegistry, type WorkerUnitLike } from './build-review-worker-registry'
import { applyDeliveryToTarget } from './build-review-messages'

function unit(role: string): WorkerUnitLike {
  return {
    role,
    choice: { agent: 'codex' },
    status: 'running',
    taskId: `task_${role}`,
    dispatchId: null,
    terminalHandle: `term_${role}`,
    report: null,
    error: null
  }
}

function doneMessage(id: string, dispatchId: string, outcome: string) {
  return {
    id,
    from_handle: 'someone',
    type: 'worker_done',
    subject: `${dispatchId} done`,
    body: 'body',
    payload: JSON.stringify({ dispatchId, outcome, filesModified: `${dispatchId}.md` })
  } as never
}

describe('WorkerUnitRegistry', () => {
  it('routes one batch to several workers by dispatch id and settles only those', async () => {
    const registry = new WorkerUnitRegistry()
    const [a, b, c] = [unit('a'), unit('b'), unit('c')]
    registry.bind(a, 'ctx_a')
    registry.bind(b, 'ctx_b')
    registry.bind(c, 'ctx_c')
    const logged: string[] = []
    const waits = [registry.waitFor(a), registry.waitFor(b), registry.waitFor(c)]
    waits[1].catch(() => undefined)
    applyDeliveryToTarget(
      registry.asMailboxTarget((_kind, _role, text) => logged.push(text)),
      [doneMessage('m1', 'ctx_a', 'succeeded'), doneMessage('m2', 'ctx_c', 'failed')]
    )
    registry.notify()
    await Promise.all([waits[0], waits[2]])
    expect(a.status).toBe('succeeded')
    expect(c.status).toBe('failed')
    expect(b.status).toBe('running')
    expect(registry.live()).toEqual([b])
    expect(a.report?.filesModified).toEqual(['ctx_a.md'])
    expect(logged.some((line) => line.includes('a reported succeeded'))).toBe(true)
  })

  it('keeps one pending question per worker and drops it on that worker_done', () => {
    const registry = new WorkerUnitRegistry()
    const [a, b] = [unit('a'), unit('b')]
    registry.bind(a, 'ctx_a')
    registry.bind(b, 'ctx_b')
    const target = registry.asMailboxTarget(() => {})
    applyDeliveryToTarget(target, [
      {
        id: 'q1',
        from_handle: 'term_a',
        type: 'question',
        body: 'which folder?',
        payload: JSON.stringify({ dispatchId: 'ctx_a', options: ['x', 'y'] })
      } as never,
      {
        id: 'q2',
        from_handle: 'term_b',
        type: 'question',
        body: 'which codec?',
        payload: JSON.stringify({ dispatchId: 'ctx_b' })
      } as never
    ])
    expect(
      registry
        .openQuestions()
        .map((entry) => entry.question.messageId)
        .sort()
    ).toEqual(['q1', 'q2'])
    expect(registry.pendingQuestionFor(a)?.options).toEqual(['x', 'y'])
    applyDeliveryToTarget(target, [doneMessage('m1', 'ctx_a', 'succeeded')])
    expect(registry.pendingQuestionFor(a)).toBeNull()
    expect(registry.pendingQuestionFor(b)?.messageId).toBe('q2')
  })

  it('ignores a settled worker and a foreign dispatch in a replayed batch', () => {
    const registry = new WorkerUnitRegistry()
    const a = unit('a')
    registry.bind(a, 'ctx_a')
    const target = registry.asMailboxTarget(() => {})
    applyDeliveryToTarget(target, [doneMessage('m1', 'ctx_a', 'succeeded')])
    applyDeliveryToTarget(target, [doneMessage('m2', 'ctx_a', 'failed')])
    expect(a.status).toBe('succeeded')
    applyDeliveryToTarget(target, [doneMessage('m3', 'ctx_unknown', 'failed')])
    expect(a.report?.subject).toBe('ctx_a done')
  })

  it('keeps a report that arrives before its worker is bound and hands it over at bind (BRG-006)', async () => {
    const registry = new WorkerUnitRegistry()
    const early = unit('early')
    const target = registry.asMailboxTarget(() => {})
    // The pump reads the worker's worker_done before its start returned to the caller.
    applyDeliveryToTarget(target, [doneMessage('m1', 'ctx_early', 'succeeded')])
    expect(early.status).toBe('running')
    const held = registry.bind(early, 'ctx_early')
    expect(held).toHaveLength(1)
    applyDeliveryToTarget(target, held)
    registry.notify()
    expect(early.status).toBe('succeeded')
    await expect(registry.waitFor(early)).resolves.toBeUndefined()
    expect(registry.bind(unit('again'), 'ctx_early')).toEqual([])
  })

  it('refuses a second waiter for one worker and fails every waiter when the pump dies', async () => {
    const registry = new WorkerUnitRegistry()
    const a = unit('a')
    registry.bind(a, 'ctx_a')
    const wait = registry.waitFor(a)
    expect(() => registry.waitFor(a)).toThrow(/already awaited/)
    registry.fail(new Error('pump stopped'))
    await expect(wait).rejects.toThrow('pump stopped')
  })

  it('stops routing to a forgotten worker', () => {
    const registry = new WorkerUnitRegistry()
    const a = unit('a')
    registry.bind(a, 'ctx_a')
    expect(registry.forDispatch('ctx_a')).toBe(a)
    expect(registry.forTerminal('term_a')).toBe(a)
    registry.forget(a)
    expect(registry.forDispatch('ctx_a')).toBeNull()
    expect(registry.forTerminal('term_a')).toBeNull()
  })
})
