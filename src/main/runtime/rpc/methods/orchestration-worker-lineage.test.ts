import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { OrchestrationDb } from '../../orchestration/db'
import { workerLineageLinks } from './orchestration-worker-lineage'

const leaf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const COORDINATOR = `tab-1:${leaf(1)}`

describe('orchestration.workerLineage', () => {
  const databases: OrchestrationDb[] = []
  afterEach(() => {
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
  })

  function seeded(): OrchestrationDb {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    const sqlite = (database as unknown as { db: Database.Database }).db
    const task = sqlite.prepare(
      'INSERT INTO tasks (id, spec, created_by_pane_key, created_by_terminal_handle) VALUES (?, ?, ?, ?)'
    )
    const dispatch = sqlite.prepare(
      `INSERT INTO dispatch_contexts (id, task_id, assignee_handle, assignee_pane_key, status, created_at)
       VALUES (?, ?, ?, ?, 'completed', datetime('now', ?))`
    )
    task.run('task_local', 'review', COORDINATOR, null)
    dispatch.run('ctx_local', 'task_local', 'term_local', `tab-2:${leaf(2)}`, '-2 hours')
    sqlite
      .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
      .run('proc-local', 'ctx_local')
    sqlite
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
           process_incarnation, host_scope, ownership_state, release_state, retained_reason
         ) VALUES ('resource_local', 'ctx_local', 'ctx_local', 'term_local', ?, 'proc-local',
                   '{"kind":"local","hostId":"local"}', 'owned', 'not_requested', NULL)`
      )
      .run(`tab-2:${leaf(2)}`)
    // A later task sent to the same worker by someone else does not move it.
    task.run('task_again', 'again', `tab-9:${leaf(9)}`, null)
    dispatch.run('ctx_again', 'task_again', 'term_local', `tab-2:${leaf(2)}`, '-1 hours')
    task.run('task_reuse', 'reuse', `tab-9:${leaf(9)}`, null)
    dispatch.run('ctx_reuse', 'task_reuse', 'term_reuse', `tab-8:${leaf(2)}`, '-5 minutes')
    sqlite
      .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
      .run('proc-local', 'ctx_reuse')
    sqlite
      .prepare(
        `UPDATE worker_terminal_resources
            SET owner_dispatch_id = 'ctx_reuse', terminal_handle = 'term_reuse',
                pane_key = ?, release_state = 'retained', retained_reason = 'user_requested'
          WHERE id = 'resource_local'`
      )
      .run(`tab-8:${leaf(2)}`)
    task.run('task_remote', 'review', COORDINATOR, null)
    dispatch.run('ctx_remote', 'task_remote', 'term_home_side', null, '-1 hours')
    sqlite
      .prepare(
        `INSERT INTO federated_dispatches
           (dispatch_id, environment_id, environment_name, peer_fingerprint, remote_terminal_handle)
         VALUES ('ctx_remote', 'env-1', 'mw0002', 'fp', 'term_remote')`
      )
      .run()
    // Only a handle, resolved while the terminal is live.
    task.run('task_handle', 'review', null, 'term_coordinator')
    dispatch.run('ctx_handle', 'task_handle', 'term_live', null, '-30 minutes')
    // Nobody launched it: a task created outside any session.
    task.run('task_orphan', 'review', null, null)
    dispatch.run('ctx_orphan', 'task_orphan', 'term_x', `tab-3:${leaf(3)}`, '-10 minutes')
    // Past the window.
    task.run('task_old', 'review', COORDINATOR, null)
    dispatch.run('ctx_old', 'task_old', 'term_old', `tab-4:${leaf(4)}`, '-40 days')
    return database
  }

  it('reads each worker once, with the session that first dispatched to it', () => {
    const paneKeys: Record<string, string> = {
      term_live: `tab-5:${leaf(5)}`,
      term_coordinator: COORDINATOR
    }
    const links = workerLineageLinks(
      seeded().listWorkerLineage(),
      (handle) => paneKeys[handle] ?? null,
      (paneKey) => (paneKey.startsWith('tab-8:') ? 'proc-local' : null)
    )
    expect(links.map(({ parentPaneKey, child }) => ({ parentPaneKey, child }))).toEqual([
      { parentPaneKey: COORDINATOR, child: { kind: 'pane', paneKey: `tab-2:${leaf(2)}` } },
      {
        parentPaneKey: COORDINATOR,
        child: { kind: 'remote-terminal', environmentId: 'env-1', terminal: 'term_remote' }
      },
      { parentPaneKey: COORDINATOR, child: { kind: 'pane', paneKey: `tab-5:${leaf(5)}` } }
    ])
    expect(links[0]!.dispatchedAt).toBeGreaterThan(Date.now() - 3 * 60 * 60_000)
  })

  it('never makes a session its own worker, even after its tab was reminted', () => {
    const links = workerLineageLinks(
      [
        {
          parent_pane_key: `tab-1:${leaf(1)}`,
          dispatch_id: 'dispatch_self',
          resource_owner_dispatch_id: null,
          resource_host_scope: null,
          retained_by_user: null,
          parent_handle: null,
          child_pane_key: `tab-7:${leaf(1)}`,
          child_handle: null,
          environment_id: null,
          remote_terminal: null,
          dispatched_at: '2026-09-21 21:58:02'
        }
      ],
      () => null
    )
    expect(links).toEqual([])
  })

  it('projects the exact dispatch and user-retention state while leaving resource-less links intact', () => {
    const database = seeded()
    const rows = database.listWorkerLineage()
    const reusedPaneWithoutIncarnation = rows.find((row) => row.dispatch_id === 'ctx_again')
    expect(reusedPaneWithoutIncarnation?.resource_owner_dispatch_id).toBeNull()
    const links = workerLineageLinks(
      rows,
      () => null,
      (paneKey) => (paneKey.startsWith('tab-8:') ? 'proc-local' : null)
    )
    const local = links.find(
      (link) => link.child.kind === 'pane' && link.child.paneKey === `tab-2:${leaf(2)}`
    )
    const remote = links.find(
      (link) => link.child.kind === 'remote-terminal' && link.child.terminal === 'term_remote'
    )
    expect(local).toMatchObject({
      parentPaneKey: COORDINATOR,
      child: { kind: 'pane', paneKey: `tab-2:${leaf(2)}` },
      dispatchId: 'ctx_reuse',
      processIncarnation: 'proc-local',
      retainedByUser: true
    })
    expect(remote).toMatchObject({ child: { kind: 'remote-terminal' } })
    expect(remote?.dispatchId).toBeUndefined()
  })

  it('keeps historical parent grouping but withholds Keep after an in-place pane restart', () => {
    const database = seeded()
    const links = workerLineageLinks(
      database.listWorkerLineage(),
      () => null,
      () => 'proc-restarted'
    )
    const worker = links.find(
      (link) => link.child.kind === 'pane' && link.child.paneKey.endsWith(leaf(2))
    )
    expect(worker).toMatchObject({ parentPaneKey: COORDINATOR, child: { kind: 'pane' } })
    expect(worker?.dispatchId).toBeUndefined()
    expect(worker?.processIncarnation).toBeUndefined()
  })

  it('clears older Keep identity when a newer dispatch has no resource yet', () => {
    const child = `tab-2:${leaf(2)}`
    const rows = [
      {
        dispatch_id: 'old',
        resource_owner_dispatch_id: 'old',
        resource_host_scope: '{"kind":"local","hostId":"local"}',
        resource_process_incarnation: 'old-inc',
        retained_by_user: 1,
        parent_pane_key: COORDINATOR,
        parent_handle: null,
        child_pane_key: child,
        child_handle: null,
        environment_id: null,
        remote_terminal: null,
        dispatched_at: '2026-09-21 21:58:02'
      },
      {
        dispatch_id: 'new',
        resource_owner_dispatch_id: null,
        resource_host_scope: null,
        resource_process_incarnation: null,
        retained_by_user: null,
        parent_pane_key: `tab-9:${leaf(9)}`,
        parent_handle: null,
        child_pane_key: child,
        child_handle: null,
        environment_id: null,
        remote_terminal: null,
        dispatched_at: '2026-09-21 22:00:02'
      }
    ]
    const link = workerLineageLinks(
      rows,
      () => null,
      () => 'new-inc'
    )[0]
    expect(link).toMatchObject({ parentPaneKey: COORDINATOR, retainedByUser: false })
    expect(link?.dispatchId).toBeUndefined()
    expect(link?.processIncarnation).toBeUndefined()
  })

  it('withholds local retention authority when the same exact pane/incarnation is ambiguous across hosts', () => {
    const database = seeded()
    const sqlite = (database as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        `INSERT INTO worker_terminal_resources (
           id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
           process_incarnation, host_scope, ownership_state, release_state
         ) VALUES ('resource_collision', 'ctx_again', 'ctx_again', 'term_reuse', ?, 'proc-local',
                  '{"kind":"ssh","targetId":"other"}', 'owned', 'not_requested')`
      )
      .run(`tab-8:${leaf(2)}`)
    const row = database.listWorkerLineage().find((item) => item.dispatch_id === 'ctx_reuse')
    expect(row?.resource_owner_dispatch_id).toBeNull()
  })

  it('keeps remote-host pane lineage but omits a local retention action', () => {
    const database = seeded()
    const sqlite = (database as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        `UPDATE worker_terminal_resources
            SET host_scope = '{"kind":"ssh","targetId":"other"}'
          WHERE id = 'resource_local'`
      )
      .run()
    const links = workerLineageLinks(
      database.listWorkerLineage(),
      () => null,
      (paneKey) => (paneKey.startsWith('tab-8:') ? 'proc-local' : null)
    )
    const worker = links.find(
      (link) => link.child.kind === 'pane' && link.child.paneKey === `tab-2:${leaf(2)}`
    )
    expect(worker).toMatchObject({ parentPaneKey: COORDINATOR, retainedByUser: true })
    expect(worker?.dispatchId).toBeUndefined()
  })
})
