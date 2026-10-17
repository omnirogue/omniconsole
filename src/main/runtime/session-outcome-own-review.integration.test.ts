import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SESSION_OUTCOME_DONE_FOR_REVIEW } from './session-outcome-verification'

/**
 * The owner's own review, end to end through the real host. "I review the result" is where
 * finished work GOES, not a question it asks (Sal, 2026-09-19): once every other criterion is
 * proven the run completes and sits in Done for the owner, asking nobody. The receipt names the
 * exact version handed over, so a later change is still a new version and an explicit approval of
 * the same bytes is still recordable.
 */
const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

function fixture() {
  const f = outcomeRuntimeFixture(() => ({ body: 'unused: nothing here launches a worker' }))
  fixtures.push(f)
  return f
}

const chain = (workspace: string) => ({
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
})

const reviewed = (workspace: string): SessionOutcomeDefinition => ({
  id: 'outcome',
  title: 'Result',
  finish: 'my-review',
  dependsOn: [],
  actions: [],
  conditions: [
    { id: 'file', kind: 'file', target: join(workspace, 'result.txt') },
    { id: 'review', kind: 'review', target: 'result' }
  ]
})

/** A second obligation nobody delivers, so the run is never sealed while the first is watched. */
const undelivered = (workspace: string): SessionOutcomeDefinition => ({
  id: 'other',
  title: 'Never delivered',
  finish: 'complete',
  dependsOn: [],
  actions: [],
  conditions: [{ id: 'file', kind: 'file', target: join(workspace, 'never.txt') }]
})

type Fixture = ReturnType<typeof fixture>
const setOf = (f: Fixture) => f.service.get('chain').outcomeSet!
const outcomeOf = (f: Fixture) => setOf(f).outcomes.find((entry) => entry.id === 'outcome')!
const versionOf = (f: Fixture): string =>
  outcomeOf(f).conditions.find((entry) => entry.id === 'review')!.version!
const reviewReceipts = (f: Fixture) =>
  outcomeOf(f).evidence.filter((entry) => entry.conditionId === 'review')
const ownerRequests = (f: Fixture) => readSessionRun(setOf(f)).attention

async function ticks(f: Fixture, count = 3): Promise<void> {
  for (let index = 0; index < count; index++) {
    await f.service.tick()
  }
}

describe("the owner's own review", () => {
  it('completes the run without asking: the result goes to Done under the version handed over', async () => {
    const f = fixture()
    f.write('result.txt', 'version 1')
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [reviewed(f.workspace)]
    })
    f.service.dispose()
    await ticks(f)

    const done = sessionOutcomeProgress(setOf(f))
    expect(done).toMatchObject({ phase: 'completed', lifecycle: 'complete', attention: [] })
    expect(setOf(f).attention ?? []).toEqual([])
    expect(outcomeOf(f).status).toBe('satisfied')
    expect(reviewReceipts(f)).toMatchObject([
      { receipt: `${SESSION_OUTCOME_DONE_FOR_REVIEW}${versionOf(f)}`, version: versionOf(f) }
    ])
    // Sealed is sealed: later passes ask nothing and change nothing.
    await ticks(f)
    expect(setOf(f).attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(setOf(f)).lifecycle).toBe('complete')
  })

  it('tracks the bytes: a change is a new version, the same bytes are the same receipt, nobody is asked', async () => {
    const f = fixture()
    f.write('result.txt', 'version 1')
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [reviewed(f.workspace), undelivered(f.workspace)]
    })
    f.service.dispose()
    await ticks(f)
    const first = versionOf(f)
    expect(outcomeOf(f).status).toBe('satisfied')
    expect(ownerRequests(f)).toEqual([])

    // The owner may still approve these exact bytes explicitly; an old version is refused.
    await f.service.review('chain', setOf(f).revision, 'outcome', 'review', first)
    expect(outcomeOf(f).evidence.some((entry) => entry.receipt === `user-review:${first}`)).toBe(
      true
    )

    f.write('result.txt', 'version 2')
    await expect(
      f.service.review('chain', setOf(f).revision, 'outcome', 'review', first)
    ).rejects.toThrow('version')
    await ticks(f)
    expect(versionOf(f)).not.toBe(first)
    expect(outcomeOf(f).status).toBe('satisfied')
    expect(ownerRequests(f)).toEqual([])
    expect(reviewReceipts(f).map((entry) => entry.version)).toEqual([versionOf(f)])

    // The old approval is history, kept: it is what comes back should those bytes return.
    expect(
      setOf(f).evidenceHistory?.filter((entry) => entry.receipt === `user-review:${first}`)
    ).toHaveLength(1)
  })
})
