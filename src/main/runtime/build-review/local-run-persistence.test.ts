import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeLocalRunGraph } from '../../../shared/local-run-graph'
import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationCaller } from './build-review-rpc-call'
import {
  LOCAL_RUN_RESTART_ERROR,
  LOCAL_RUN_RESTART_EVENT,
  LocalRunStore
} from './local-run-persistence'
import { LocalRunService } from './local-run-service'
import { createLocalRunSnapshot } from './local-run-state'

/**
 * Local runs used to live only in the service's Map, so a restart erased the Jobs
 * list even though the orchestration rows survived. These cover the disk side of
 * that: what is written, what comes back, and what a restart does to work the
 * previous process was still executing.
 */
describe('local run persistence', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'local-runs-'))
    directories.push(path)
    return join(path, 'local-runs')
  }

  const call: OrchestrationCaller = (async () => ({})) as unknown as OrchestrationCaller

  function runtimeStub(): OrcaRuntimeService {
    return { notifyLocalRunChanged: () => {} } as unknown as OrcaRuntimeService
  }

  function service(path: string): LocalRunService {
    return new LocalRunService(runtimeStub(), call, { directory: path })
  }

  function graph(workspacePath: string) {
    return {
      workspacePath,
      nodes: [
        { id: 'research', actor: { agent: 'claude' }, presetId: 'research', objective: 'Read' },
        {
          id: 'build',
          actor: { agent: 'codex' },
          presetId: 'implement',
          objective: 'Build',
          deps: ['research']
        }
      ]
    }
  }

  function snapshotOnDisk(path: string, id: string): LocalRunSnapshot {
    return JSON.parse(readFileSync(join(path, `${id}.json`), 'utf-8')) as LocalRunSnapshot
  }

  function persist(path: string, snapshot: LocalRunSnapshot): void {
    const store = new LocalRunStore(path, () => {})
    store.save(snapshot)
    store.flush()
  }

  function activeSnapshot(workspacePath: string): LocalRunSnapshot {
    const normalized = normalizeLocalRunGraph(graph(workspacePath))
    if (!normalized) {
      throw new Error('The fixture graph must normalize.')
    }
    const snapshot = createLocalRunSnapshot({
      graph: normalized,
      workspaceKind: 'folder',
      maxConcurrent: 2
    })
    snapshot.stage = 'running'
    snapshot.runId = 'run_fixture'
    snapshot.nodes[0].state = 'running'
    snapshot.nodes[1].state = 'queued'
    return snapshot
  }

  it('lists a created run again from a new service over the same directory', () => {
    const path = directory()
    const created = service(path).create(graph('/tmp/workspace-a'))
    expect(readdirSync(path)).toContain(`${created.id}.json`)

    const restarted = service(path)
    const listed = restarted.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(created.id)
    expect(listed[0].stage).toBe('created')
    expect(listed[0].nodes.map((node) => node.id)).toEqual(['research', 'build'])
    expect(restarted.show(created.id).workspacePath).toBe('/tmp/workspace-a')
  })

  it('keeps a created run startable after a restart', async () => {
    const path = directory()
    const created = service(path).create(graph('/tmp/workspace-b'))
    const restarted = service(path)

    // Startable means `start` accepts it; the stub runtime then fails the run, which
    // is exactly what makes it observable without touching a real workspace.
    expect(() => restarted.start(created.id)).not.toThrow()
    await restarted.cancel(created.id)
    expect(restarted.show(created.id).stage).not.toBe('created')
  })

  it('writes a settled run before save returns, without waiting for the debounce', () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-c')
    const store = new LocalRunStore(path, () => {})
    store.save(snapshot)
    snapshot.stage = 'completed'
    snapshot.nodes[0].state = 'completed'
    store.save(snapshot)

    const written = snapshotOnDisk(path, snapshot.id)
    expect(written.stage).toBe('completed')
    expect(written.nodes[0].state).toBe('completed')
  })

  it('fails a run the app restarted on top of, and says so', () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-d')
    snapshot.nodes[1].state = 'reviewing'
    persist(path, snapshot)

    const loaded = service(path).show(snapshot.id)
    expect(loaded.stage).toBe('failed')
    expect(loaded.error).toBe(LOCAL_RUN_RESTART_ERROR)
    expect(loaded.nodes.map((node) => node.state)).toEqual(['failed', 'failed'])
    expect(loaded.nodes.map((node) => node.error)).toEqual([
      LOCAL_RUN_RESTART_ERROR,
      LOCAL_RUN_RESTART_ERROR
    ])
    expect(loaded.events.at(-1)?.text).toBe(LOCAL_RUN_RESTART_EVENT)
    // The repair is durable: a second restart must not append the notice twice.
    expect(snapshotOnDisk(path, snapshot.id).stage).toBe('failed')
    const twice = service(path).show(snapshot.id)
    expect(twice.events.filter((event) => event.text === LOCAL_RUN_RESTART_EVENT)).toHaveLength(1)
  })

  it('leaves an unstarted node queued when the app restarted mid-run', () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-e')
    persist(path, snapshot)

    const loaded = service(path).show(snapshot.id)
    expect(loaded.nodes[0].state).toBe('failed')
    expect(loaded.nodes[1].state).toBe('queued')
    expect(loaded.nodes[1].error).toBeNull()
  })

  it('loads a settled run exactly as it was', () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-f')
    snapshot.stage = 'completed'
    snapshot.nodes[0].state = 'completed'
    snapshot.nodes[1].state = 'completed'
    persist(path, snapshot)

    const restarted = service(path)
    expect(restarted.show(snapshot.id).stage).toBe('completed')
    expect(restarted.show(snapshot.id).events).toHaveLength(0)
  })

  it('cancelling a loaded finished run returns it untouched', async () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-g')
    snapshot.stage = 'cancelled'
    persist(path, snapshot)

    const restarted = service(path)
    const cancelled = await restarted.cancel(snapshot.id)
    expect(cancelled.stage).toBe('cancelled')
    expect(restarted.list()).toHaveLength(1)
  })

  it('skips corrupt or foreign files with a warning and keeps the rest', () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-h')
    snapshot.stage = 'completed'
    persist(path, snapshot)
    writeFileSync(join(path, 'lrn_broken0000.json'), '{ not json')
    writeFileSync(join(path, 'lrn_notarun0000.json'), JSON.stringify({ id: 'lrn_notarun0000' }))
    writeFileSync(join(path, 'notes.txt'), 'ignored')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const restarted = new LocalRunService(runtimeStub(), call, { directory: path })
    expect(restarted.list().map((run) => run.id)).toEqual([snapshot.id])
    expect(warn).toHaveBeenCalled()
  })

  it('reads nothing and throws nothing when the directory does not exist', () => {
    expect(new LocalRunStore(join(directory(), 'missing'), () => {}).load()).toEqual([])
  })

  it('forgets a run the service evicted', () => {
    const path = directory()
    const snapshot = activeSnapshot('/tmp/workspace-i')
    snapshot.stage = 'failed'
    persist(path, snapshot)
    const store = new LocalRunStore(path, () => {})

    store.remove(snapshot.id)
    expect(readdirSync(path)).not.toContain(`${snapshot.id}.json`)
    expect(store.load()).toEqual([])
  })
})
