import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OrchestrationDb } from './orchestration/db'
import { ensureAttachedSessionOutcomePlanningSource } from './session-outcome-attached-planning-source'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const chain = { sourcePaneKey: 'source', worktreeId: 'folder:outcome' } as SessionChain
const io = (sessions = [{ id: 'ses_source' }]) => ({
  taskCard: async () => ({ ok: true as const, data: { id: 'btk_task', title: 'Real task' } }),
  taskSessions: async () => ({ ok: true as const, data: { sessions } }),
  sourceBinding: async () => ({
    ok: true as const,
    data: { id: 'ses_source', board_task_id: 'btk_task', session_ref: 'native' }
  })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'attached-planning-'))
  const db = new OrchestrationDb(join(dir, 'db.sqlite'))
  cleanups.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const runtime = {
    getOrchestrationDb: () => db,
    resolveSessionOutcomePlanningCoordinator: () => ({
      handle: 'agent-session:native',
      paneKey: 'source',
      processIncarnation: 'structured:native'
    })
  } as unknown as OrcaRuntimeService
  return { db, runtime }
}

it('creates only a pristine planning run from the exact server-confirmed attachment', async () => {
  const f = fixture()
  await ensureAttachedSessionOutcomePlanningSource(
    f.runtime,
    chain,
    { taskId: 'btk_task', sessionId: 'ses_source' },
    'principal',
    io() as never
  )
  const run = f.db.getCurrentRunForPane('source')!
  const task = f.db.listTasks({ runId: run.id })[0]!
  expect(run).toMatchObject({ hub_task_id: 'btk_task', origin: 'local_bound' })
  expect(f.db.getDispatchContext(task.id)).toBeUndefined()
})

it('refuses a cached task link absent from the authenticated task sessions', async () => {
  const f = fixture()
  await expect(
    ensureAttachedSessionOutcomePlanningSource(
      f.runtime,
      chain,
      { taskId: 'btk_task', sessionId: 'ses_source' },
      'principal',
      io([]) as never
    )
  ).rejects.toThrow('not attached')
  expect(f.db.getCurrentRunForPane('source')).toBeUndefined()
})

it('refuses planning ownership without the signed principal', async () => {
  const f = fixture()
  await expect(
    ensureAttachedSessionOutcomePlanningSource(
      f.runtime,
      chain,
      { taskId: 'btk_task', sessionId: 'ses_source' },
      null,
      io() as never
    )
  ).rejects.toThrow('Sign in')
  expect(f.db.getCurrentRunForPane('source')).toBeUndefined()
})

it('refuses another server-attached session even when it appears under the same task', async () => {
  const f = fixture()
  await expect(
    ensureAttachedSessionOutcomePlanningSource(
      f.runtime,
      chain,
      { taskId: 'btk_task', sessionId: 'ses_source' },
      'principal',
      {
        ...io(),
        sourceBinding: async () => ({
          ok: true,
          data: {
            id: 'ses_source',
            board_task_id: 'btk_task',
            session_ref: 'another-native-source'
          }
        })
      } as never
    )
  ).rejects.toThrow('actual source conversation')
  expect(f.db.getCurrentRunForPane('source')).toBeUndefined()
})

it('uses the confirmed canonical pane binding without requiring a legacy worker session', async () => {
  const f = fixture()
  const ledger = 'als_0123456789abcdef01234567'
  const taskSessions = vi.fn().mockRejectedValue(new Error('Legacy worker list is not this source'))
  await ensureAttachedSessionOutcomePlanningSource(
    f.runtime,
    chain,
    { taskId: 'btk_task', sessionId: ledger },
    'principal',
    {
      ...io(),
      taskSessions,
      sourceBinding: async () => ({
        ok: true,
        data: { id: ledger, board_task_id: 'btk_task', session_ref: 'source' }
      })
    } as never
  )
  expect(taskSessions).not.toHaveBeenCalled()
  expect(f.db.getCurrentRunForPane('source')).toMatchObject({
    hub_task_id: 'btk_task',
    origin: 'local_bound'
  })
})

it.each(['wrong-pane', 'wrong-task', 'changed-principal', 'changed-process'])(
  'refuses canonical planning with %s',
  async (kind) => {
    const f = fixture()
    const ledger = 'als_0123456789abcdef01234567'
    await expect(
      ensureAttachedSessionOutcomePlanningSource(
        f.runtime,
        chain,
        { taskId: 'btk_task', sessionId: ledger },
        'principal',
        {
          ...io(),
          principal: async () => (kind === 'changed-principal' ? 'other-principal' : 'principal'),
          sourceBinding: async () => {
            if (kind === 'changed-process') {
              f.runtime.resolveSessionOutcomePlanningCoordinator = () => ({
                handle: 'agent-session:native',
                paneKey: 'source',
                processIncarnation: 'replacement'
              })
            }
            return {
              ok: true,
              data: {
                id: ledger,
                board_task_id: kind === 'wrong-task' ? 'btk_other' : 'btk_task',
                session_ref: kind === 'wrong-pane' ? 'other-pane' : 'source'
              }
            }
          }
        } as never
      )
    ).rejects.toThrow()
    expect(f.db.getCurrentRunForPane('source')).toBeUndefined()
  }
)
