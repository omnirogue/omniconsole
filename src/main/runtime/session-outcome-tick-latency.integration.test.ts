import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import type { SessionChain } from '../../shared/session-chain-types'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release()
  }
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

function chain(id: string, workspace: string): SessionChain {
  return {
    id,
    workspacePath: workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: `source_${id}`,
    sourceRowKey: `row_${id}`,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  } as unknown as SessionChain
}

async function commit(f: Fixture, id: string): Promise<void> {
  await f.service.commit(chain(id, f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [
      {
        id,
        title: id,
        finish: 'complete',
        dependsOn: [],
        conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, `${id}.txt`) }],
        actions: [
          {
            id: `write_${id}`,
            instruction: `ACTION:${id}`,
            agent: 'codex',
            conditionIds: ['file'],
            authority: 'existing-user-authority'
          }
        ]
      }
    ]
  })
}

it('does not hold one chain behind another chain slow worker start', async () => {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const action = /ACTION:(\w+)/.exec(spec)![1]!
    writeFileSync(join(workspace, `${action}.txt`), 'done')
    return { body: `Produced ${action}` }
  })
  fixtures.push(f)
  // The first agent never becomes ready — the real wait is up to 180 s, and this one is longer.
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  const ready = vi.mocked(f.runtime.waitForTerminal)
  const answer = ready.getMockImplementation()!
  let first = true
  ready.mockImplementation(async (handle, options) => {
    if (first) {
      first = false
      await held
    }
    return answer(handle, options)
  })

  // Held before the commits: the startup pass `commit` runs may be the one that launches slow.
  await commit(f, 'slow')
  await commit(f, 'quick')
  f.service.dispose()

  const started = Date.now()
  // The tick the service actually runs, not the fixture's wrapper that waits for its launches.
  await f.hostTick()
  const tickMs = Date.now() - started

  // A tick that waited for readiness would sit here for minutes.
  expect(tickMs).toBeLessThan(5_000)
  // The second chain's worker starts while the first is still waiting to be ready.
  for (
    let index = 0;
    index < 40 && !f.launched.some((spec) => spec.includes('ACTION:quick'));
    index++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(f.launched.some((spec) => spec.includes('ACTION:quick'))).toBe(true)
  expect(f.launched.some((spec) => spec.includes('ACTION:slow'))).toBe(false)

  const attempts = f.service.get('slow').outcomeSet!.attempts
  expect(attempts).toHaveLength(1)
  // Its attempt is durable while the wait runs on, so a restart reconciles it instead of
  // dispatching a second worker, and the slot it holds is not handed to anyone else.
  expect(['prepared', 'launching']).toContain(attempts[0]!.state)
  expect(f.service.launches.inFlight(attempts[0]!.id)).toBe(true)

  release()
  await f.service.launches.settled()
  expect(f.launched.some((spec) => spec.includes('ACTION:slow'))).toBe(true)
})
