import { afterEach, describe, expect, it } from 'vitest'
import { handoffSession } from './session-manage-handoff'
import { transferFixture, transferSession } from './session-manage-transfer-fixtures'
import { setSessionWaitRepointer } from './session-transfer-adoption'

const restores: (() => void)[] = []
afterEach(() => {
  while (restores.length) {
    restores.pop()!()
  }
})

const source = transferSession('source')

describe('adopting a merged session’s waiters', () => {
  it('points waits on the source at the target after acknowledgement and before archive', async () => {
    const { deps, events, target } = transferFixture()
    const waiting = new Map([['source', ['waiter-1']]])
    restores.push(
      setSessionWaitRepointer(async ({ from, to }) => {
        events.push(`repoint:${from}->${to}`)
        const moved = waiting.get(from) ?? []
        waiting.set(to, [...(waiting.get(to) ?? []), ...moved])
        waiting.delete(from)
        return moved.length
      })
    )
    const result = await handoffSession(deps, {
      actor: { kind: 'cli' },
      sources: [source],
      target,
      dryRun: false
    })
    expect(result.outcome).toBe('completed')
    expect(events.indexOf('audit:session.acknowledge')).toBeLessThan(
      events.indexOf('repoint:source->target')
    )
    expect(events.indexOf('repoint:source->target')).toBeLessThan(events.indexOf('archive'))
    // The waiter now waits on the target, so the target's result wakes it.
    expect(waiting).toEqual(new Map([['target', ['waiter-1']]]))
    expect(result.summary).toContain('1 wait on the source now follows “target”')
  })

  it('archives nothing when the waits could not be moved', async () => {
    const { deps, target } = transferFixture()
    restores.push(
      setSessionWaitRepointer(async () => {
        throw new Error('the waiter’s plan changed; nothing moved')
      })
    )
    const result = await handoffSession(deps, {
      actor: { kind: 'cli' },
      sources: [source],
      target,
      dryRun: false
    })
    expect(result).toMatchObject({ outcome: 'failed', failedStep: 'adopt unfinished work' })
    expect(deps.archive).not.toHaveBeenCalled()
  })

  it('adopts nothing, and archives as before, while session waits do not run here', async () => {
    const { deps, target } = transferFixture()
    const result = await handoffSession(deps, {
      actor: { kind: 'cli' },
      sources: [source],
      target,
      dryRun: false
    })
    expect(result.outcome).toBe('completed')
    expect(deps.archive).toHaveBeenCalledOnce()
    expect(result.summary).not.toContain('wait')
  })
})
