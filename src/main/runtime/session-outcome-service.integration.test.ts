import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})
const definition = (id: string, dir: string): SessionOutcomeDefinition => ({
  id,
  title: id,
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: join(dir, `${id}.txt`) }],
  actions: [
    {
      id: `write_${id}`,
      instruction: `ACTION:${id}`,
      agent: 'codex',
      conditionIds: ['file'],
      authority: 'existing-user-authority'
    }
  ]
})
function chain(workspace: string) {
  return {
    id: 'chain',
    workspacePath: workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('outcome service through real host orchestration RPC and durable profile', () => {
  it('executes two outcomes without a renderer and continues after partial completion without duplicate launches', async () => {
    const f = outcomeRuntimeFixture((spec, workspace) => {
      const id = /ACTION:(\w+)/.exec(spec)![1]!
      writeFileSync(join(workspace, `${id}.txt`), `result:${id}`)
      return { body: `Produced ${id}` }
    })
    fixtures.push(f)
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition('one', f.workspace), definition('two', f.workspace)]
    })
    f.service.dispose()
    for (let index = 0; index < 8; index++) {
      await f.service.tick()
      await f.settle()
    }
    const saved = f.service.get('chain')
    expect(sessionOutcomeProgress(saved.outcomeSet!)).toMatchObject({
      lifecycle: 'complete',
      satisfied: 2,
      total: 2
    })
    expect(f.launched).toHaveLength(2)
    // Success is recorded once and sealed: done, with nothing for any window to close.
    expect(saved.state).toBe('done')
    expect(saved.outcomeSet!.completion!.outcomes.map((outcome) => outcome.id)).toEqual([
      'one',
      'two'
    ])
    expect(saved.outcomeSet!.disposition).toMatchObject({ intent: 'completed', state: 'applied' })
    await f.service.tick()
    await f.service.tick()
    expect(f.launched).toHaveLength(2)
    expect(f.service.get('chain')).toEqual(saved)
    expect(
      saved.outcomeSet!.attempts.every((attempt) => attempt.taskId && attempt.dispatchId)
    ).toBe(true)
  })
  it('allows independent success while a sibling action fails, and never treats failed exit as success', async () => {
    const f = outcomeRuntimeFixture((spec, workspace) => {
      const id = /ACTION:(\w+)/.exec(spec)![1]!
      if (id === 'blocked') {
        return { body: 'Missing required access', outcome: 'failed' }
      }
      writeFileSync(join(workspace, `${id}.txt`), 'produced')
      return { body: 'Produced' }
    })
    fixtures.push(f)
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition('blocked', f.workspace), definition('independent', f.workspace)]
    })
    f.service.dispose()
    for (let index = 0; index < 8; index++) {
      await f.service.tick()
      await f.settle()
    }
    const saved = f.service.get('chain')
    const progress = sessionOutcomeProgress(saved.outcomeSet!)
    // A worker that failed is an operational failure the host recovers from or reports honestly.
    // It asks nothing of a person, so it is never "needs you" — and never success either.
    expect(progress).toMatchObject({ lifecycle: 'waiting', satisfied: 1, total: 2, attention: [] })
    expect(progress.phase).not.toBe('needs-you')
    expect(progress.phase).not.toBe('completed')
    expect(saved.state).toBe(progress.phase === 'failed' ? 'failed' : 'waiting')
    expect(saved.outcomeSet!.completion).toBeUndefined()
    expect(f.launched).toHaveLength(2)
  })
})

it('isolates a chain whose advancement and blocker persistence both fail on every tick', async () => {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const id = /ACTION:(\w+)/.exec(spec)![1]!
    writeFileSync(join(workspace, `${id}.txt`), 'actual result')
    return { body: 'Produced actual result' }
  })
  fixtures.push(f)
  await f.service.commit(
    { ...chain(f.workspace), id: 'broken' },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [{ ...definition('broken', f.workspace), actions: [] }]
    }
  )
  f.service.dispose()
  await f.service.commit(
    {
      ...chain(f.workspace),
      id: 'healthy',
      sourcePaneKey: 'other-source',
      sourceRowKey: 'other-row'
    },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition('healthy', f.workspace)]
    }
  )
  f.service.dispose()
  f.write('broken.txt', 'result needing evidence persistence')
  const persist = vi.mocked(f.runtime.replaceSessionChainOutcomesAndFlush)
  const original = persist.getMockImplementation()!
  persist.mockImplementation((value, revision) => {
    if (value.id === 'broken') {
      throw new Error('Simulated per-chain durable write rejection')
    }
    return original(value, revision)
  })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (let index = 0; index < 6; index++) {
    await expect(f.service.tick()).resolves.toBeUndefined()
    await f.settle()
  }
  expect(sessionOutcomeProgress(f.service.get('healthy').outcomeSet!).lifecycle).toBe('complete')
  expect(sessionOutcomeProgress(f.service.get('broken').outcomeSet!).lifecycle).not.toBe('complete')
  expect(f.launched).toHaveLength(1)
  expect(warning).toHaveBeenCalledWith(
    '[outcomes] Chain tick failed',
    'broken',
    expect.objectContaining({ message: 'Simulated per-chain durable write rejection' })
  )
  expect(persist.mock.calls.filter(([value]) => value.id === 'broken').length).toBeGreaterThan(2)
})
