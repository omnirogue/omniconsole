import { afterEach, expect, it } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { createHubTaskProjection } from './orchestration/db/tasks/task-store'
import { sessionOutcomeMutationAuthority } from './session-outcome-authority'
import type { SessionChain } from '../../shared/session-chain-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})
const brief = 'Create the approved file, obtain both adversarial reviews, then hand it to Sal.'
function fixture(native = true, executionBrief: unknown = brief) {
  const f = outcomeRuntimeFixture(() => ({ body: 'done' }))
  fixtures.push(f)
  const run = f.db.createRun({
    objective: 'User-authorized source',
    coordinatorHandle: 'coord',
    coordinatorPaneKey: 'coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ...(native ? { hubTaskId: 'btk_nativeoutcomes' } : {})
  })
  const task = native
    ? createHubTaskProjection(f.db, { runId: run.id, hubTaskId: 'btk_nativeoutcomes' })
    : f.db.createTask({ runId: run.id, spec: 'Personal authorized task' })
  const options = { executionBrief, resolvedWorktreeId: 'folder:outcome' }
  const dispatch = f.db.createStartingWorkerDispatch({
    taskId: task.id,
    creator: { kind: 'system' },
    maxDepth: 3,
    startOptions: options
  }).dispatch
  const capability = f.db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'source',
    paneKey: f.runtime.getTerminalPaneKey('source')!,
    processIncarnation: f.runtime.getTerminalProcessIncarnation('source')!,
    worktreeId: 'folder:outcome',
    effects: [],
    setupState: 'skipped'
  })
  const chain = { sourcePaneKey: 'source', worktreeId: 'folder:outcome' } as SessionChain
  const context = { runtime: f.runtime, orchestrationCapability: capability }
  const read = () => sessionOutcomeMutationAuthority(context, chain, 'user')
  return { ...f, run, task, dispatch, context, options, chain, read }
}

it('attests the exact admitted native brief while preserving the immutable card projection', () => {
  const f = fixture()
  expect(f.db.getRun(f.run.id)?.origin).toBe('local_bound')
  expect(f.read()).toEqual({ source: 'ai', instruction: brief })
  expect(f.db.getTask(f.task.id)?.spec).toBe('btk_nativeoutcomes')
  expect(f.launched).toEqual([])
})

it('requires active capability ownership before reading the native brief', () => {
  const f = fixture()
  expect(() =>
    sessionOutcomeMutationAuthority(
      { ...f.context, orchestrationCapability: 'forged' },
      f.chain,
      'user'
    )
  ).toThrow('does not own')
  f.db.failWorkerStart(f.dispatch.id, 'setup', 'failed')
  expect(f.read).toThrow('does not own')
})

it('refuses a different card or workspace receipt instead of attributing its brief', () => {
  const f = fixture()
  const update = (card: string, worktree: string, options = f.options) =>
    f.db.db
      .prepare(
        'UPDATE worker_dispatches SET hub_task_id = ?, worktree_id = ?, start_options = ? WHERE dispatch_id = ?'
      )
      .run(card, worktree, JSON.stringify(options), f.dispatch.id)
  expect(() => update('btk_other', 'folder:outcome')).toThrow('Hub card binding is immutable')
  expect(f.read().instruction).toBe(brief)
  update('btk_nativeoutcomes', 'folder:other')
  expect(f.read).toThrow('does not match')
  update('btk_nativeoutcomes', 'folder:outcome', {
    ...f.options,
    resolvedWorktreeId: 'folder:other'
  })
  expect(f.read).toThrow('does not match')
  update('btk_nativeoutcomes', 'folder:outcome')
  expect(f.read().instruction).toBe(brief)
})

it.each(['', 42, 'x'.repeat(256_001)])('refuses malformed native briefs (case %#)', (value) => {
  expect(fixture(true, value).read).toThrow('does not match')
})

it('retains task-spec authority for absent briefs, personal Runs and sealed hub origins', () => {
  const absent = fixture(true, null)
  expect(absent.read().instruction).toBe(absent.task.spec)
  const personal = fixture(false)
  expect(personal.read().instruction).toBe(personal.task.spec)
  const sealed = fixture()
  sealed.db.db.prepare("UPDATE runs SET origin = 'hub_dispatched' WHERE id = ?").run(sealed.run.id)
  expect(sealed.read().instruction).toBe(sealed.task.spec)
})
