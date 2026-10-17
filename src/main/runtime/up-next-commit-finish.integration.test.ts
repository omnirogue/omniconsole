/**
 * Done → Close really ends the session (brief 54 NA-g), driven through the real outcome host.
 *
 * Two live-sim runs recorded the opposite: the finish was committed and the tab stayed open. The
 * chains are still in Sal's profile (`source_b3cefdb0…`, `source_4caddd31…`): `sessionFinish
 * {action:'end'}`, `my-review` open, `evidence: []` — and `sourceReady: true`, so the pane was
 * readable all along. Two things had to be true at once for that state:
 *
 *   1. the person's own review obligation survived their Done (`up-next-commit-finish.ts`), and
 *   2. the `session` criterion the finish binds was never verified after the commit that added
 *      it: `SessionOutcomeService.commit` only re-verifies outcomes that ALREADY carry evidence,
 *      and the tick's status recompute runs on step completions — of which a finished pursuit
 *      has none left (`session-outcome-tick.ts`).
 *
 * The renderer watcher closes the tab on `lifecycle: 'complete'` and nothing else
 * (`session-finish-actions.ts:99-157`), so that is what this asserts.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import { SESSION_RUN_SEALED_ERROR } from '../../shared/session-run-sealed-revision'
import { UP_NEXT_REFUSAL_KEYS, type UpNextDoneBlock } from '../../shared/up-next-types'
import { upNextCommitFinish } from './up-next-commit-finish'
import { upNextWithdrawFinish } from './up-next-finish-withdraw'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.dispose()
  }
})

function fixture() {
  const entry = outcomeRuntimeFixture(() => ({ body: 'no worker runs in this test' }))
  fixtures.push(entry)
  return entry
}

const ROW = 'row'

const chain = (workspace: string) => ({
  id: 'chain',
  workspacePath: workspace,
  worktreeId: 'folder:outcome',
  hostId: 'local',
  sourcePaneKey: 'source',
  sourceRowKey: ROW,
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
})

/** What a first Up next commit authors when the person typed no Outcome of their own. */
const composerAuthored = (): SessionOutcomeDefinition =>
  ({
    id: 'outcome',
    title: 'Here is the current work. Improve it and return the updated result.',
    finish: 'my-review',
    dependsOn: [],
    conditions: [
      { id: 'my-review', kind: 'review', label: 'I have reviewed the result', target: 'outcome' }
    ],
    actions: []
  }) as unknown as SessionOutcomeDefinition

const DONE_CLOSE = {
  id: 'done',
  kind: 'done',
  state: 'draft',
  number: '',
  locked: false,
  finish: 'close'
} as UpNextDoneBlock

it('ends the session the person said to close, without a second tick of their own review', async () => {
  const f = fixture()
  await f.service.commit(chain(f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [composerAuthored()]
  })
  f.service.dispose()
  await f.service.tick()
  // Where the live runs sat: the work is done, the person's own review is the only thing left.
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).not.toBe('complete')

  await upNextCommitFinish(
    {
      runtime: f.runtime,
      conversationId: { kind: 'pty', worktreeId: 'folder:outcome', paneKey: 'source' },
      rowKey: ROW
    },
    DONE_CLOSE
  )
  await f.service.tick()

  const set = f.service.get('chain').outcomeSet!
  expect(set.sessionFinish).toEqual({ action: 'end' })
  expect(sessionOutcomeProgress(set).reasons).toEqual([])
  expect(sessionOutcomeProgress(set).lifecycle).toBe('complete')
  // The finish is bound to the exact turn it was saved against, so the disposition the renderer
  // applies is verified rather than assumed.
  expect(set.outcomes[0]!.evidence.map((entry) => entry.kind)).toEqual(['session'])
  // The host records the success once and asks a window for the Close, under one operation.
  expect(f.service.get('chain').state).toBe('done')
  expect(set.completion).toBeDefined()
  expect(set.disposition).toMatchObject({ intent: 'close', state: 'pending', attempts: 0 })
  // Done on a finished pursuit is history: it can be neither repeated nor taken back.
  const ctx = {
    runtime: f.runtime,
    conversationId: { kind: 'pty' as const, worktreeId: 'folder:outcome', paneKey: 'source' },
    rowKey: ROW
  }
  await expect(upNextCommitFinish(ctx, DONE_CLOSE)).rejects.toThrow(
    UP_NEXT_REFUSAL_KEYS.doneNeedsWork
  )
  await expect(upNextWithdrawFinish(ctx)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.doneNeedsWork)
  expect(f.service.get('chain').outcomeSet).toEqual(set)
})

it('keeps a pursuit open while a criterion that is not the person’s review is unmet', async () => {
  const f = fixture()
  const withFile: SessionOutcomeDefinition = {
    ...composerAuthored(),
    conditions: [
      ...composerAuthored().conditions,
      { id: 'receipt', kind: 'file', target: 'receipt.md' }
    ]
  }
  await f.service.commit(chain(f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [withFile]
  })
  f.service.dispose()

  await upNextCommitFinish(
    {
      runtime: f.runtime,
      conversationId: { kind: 'pty', worktreeId: 'folder:outcome', paneKey: 'source' },
      rowKey: ROW
    },
    DONE_CLOSE
  )
  await f.service.tick()

  // Done answered the review it was; the file the Outcome names still has to exist.
  const set = f.service.get('chain').outcomeSet!
  expect(set.outcomes[0]!.conditions.map((condition) => condition.id)).toEqual([
    'receipt',
    'session_finish_source'
  ])
  expect(sessionOutcomeProgress(set).lifecycle).not.toBe('complete')

  // ... and once it does, the finish the person recorded is reached without any further input.
  f.write('receipt.md', 'signed')
  await f.service.tick()
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
})

it('answers a Done that raced the seal in its own words, never with the host’s raw refusal', async () => {
  const f = fixture()
  // No host pass may write between the reading below and the final comparison.
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  const withFile: SessionOutcomeDefinition = {
    ...composerAuthored(),
    conditions: [
      ...composerAuthored().conditions,
      { id: 'receipt', kind: 'file', target: 'receipt.md' }
    ]
  }
  await f.service.commit(chain(f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [withFile]
  })
  f.service.dispose()
  const ctx = {
    runtime: f.runtime,
    conversationId: { kind: 'pty' as const, worktreeId: 'folder:outcome', paneKey: 'source' },
    rowKey: ROW
  }
  await upNextCommitFinish(ctx, DONE_CLOSE)
  const recorded = f.service.get('chain')

  // The run was still open when Up next read it and sealed before its commit reached the lane.
  const commit = vi.spyOn(f.service, 'commit')
  commit.mockRejectedValue(new Error(SESSION_RUN_SEALED_ERROR))
  await expect(upNextCommitFinish(ctx, DONE_CLOSE)).rejects.toThrow(
    UP_NEXT_REFUSAL_KEYS.doneNeedsWork
  )
  await expect(upNextWithdrawFinish(ctx)).rejects.toThrow(UP_NEXT_REFUSAL_KEYS.doneNeedsWork)

  // Any other refusal is the host's to word, and passes through untouched.
  commit.mockRejectedValue(new Error('Outcome revision conflict.'))
  await expect(upNextCommitFinish(ctx, DONE_CLOSE)).rejects.toThrow('Outcome revision conflict.')
  await expect(upNextWithdrawFinish(ctx)).rejects.toThrow('Outcome revision conflict.')
  expect(f.service.get('chain')).toEqual(recorded)
})
