import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPrepWorkspace } from './session-prep-host'
import { SessionPrepRequests, type RequestParams } from './session-prep-requests'
import { SessionPrepStore } from './session-prep-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'prep-acceptance-'))
  directories.push(directory)
  const store = new SessionPrepStore(directory)
  const schedule = vi.fn()
  let id = 0
  const requests = new SessionPrepRequests(
    store,
    () => 1,
    () => `batch-${++id}`,
    schedule
  )
  return { directory, store, schedule, requests }
}

const request: RequestParams = {
  requestId: 'objective-a',
  text: 'Review deployment',
  source: {
    worktreeId: 'repo::/src',
    paneKey: 'need-speed:profile:work',
    agent: 'codex',
    entryPoint: 'work'
  },
  context: '',
  agentTemplateId: 'reviewer',
  defaultFolder: 'project-a'
}

it('accepts concurrent retries once and recovers the same identity after a restart', async () => {
  const { directory, requests, store } = await fixture()
  const results = await Promise.all(
    Array.from({ length: 5 }, () => requests.requestDurable(request))
  )
  expect(new Set(results.map((result) => result.batchId)).size).toBe(1)
  expect(store.list()).toHaveLength(1)
  const recovered = new SessionPrepStore(directory)
  const afterRestart = new SessionPrepRequests(
    recovered,
    Date.now,
    () => 'wrong-new-batch',
    vi.fn()
  )
  expect(await afterRestart.requestDurable(request)).toEqual(results[0])
  expect(recovered.list()[0]).toMatchObject({
    requestId: request.requestId,
    source: request.source,
    agentTemplateId: 'reviewer',
    defaultFolder: 'project-a'
  })
})

it('does not schedule before durable acceptance and retries the retained identity after a failed write', async () => {
  const { requests, store, schedule } = await fixture()
  vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('disk full'))
  await expect(requests.requestDurable(request)).rejects.toThrow('disk full')
  expect(schedule).not.toHaveBeenCalled()
  expect(await requests.requestDurable(request)).toEqual({ batchId: 'batch-1' })
  expect(schedule).toHaveBeenCalledWith('batch-1')
  expect(store.list()).toHaveLength(1)
})

it('rejects changed work or provenance under an accepted identity', async () => {
  const { requests } = await fixture()
  await requests.requestDurable(request)
  for (const changed of [
    { ...request, text: 'Deploy production' },
    { ...request, source: { ...request.source, paneKey: 'other-profile' } },
    { ...request, defaultFolder: 'another-project' },
    { ...request, agentTemplateId: 'builder' }
  ]) {
    await expect(requests.requestDurable(changed)).rejects.toThrow('different work')
  }
})

it('keeps separate prompt rows independent even when their words match', async () => {
  const { requests, store } = await fixture()
  const first = await requests.requestDurable(request)
  const second = await requests.requestDurable({ ...request, requestId: 'objective-b' })
  expect(first.batchId).not.toBe(second.batchId)
  expect(store.list().map((batch) => batch.request)).toEqual([request.text, request.text])
})

describe('terminal requests are checked before they are reported started', () => {
  const PANE = 'tab-1:leaf-1'
  const terminal: RequestParams = {
    text: 'launch a session to clean stale containers',
    source: { worktreeId: 'folder:gone', paneKey: PANE, agent: 'claude' },
    context: ''
  }
  const workspaces: Record<string, SessionPrepWorkspace> = {
    'folder:work': { path: '/Users/me/Work', repoId: 'work', isFolder: true, isRemote: false },
    'folder:paired': {
      path: '/Users/me/Work',
      repoId: 'paired',
      isFolder: true,
      isRemote: true,
      hostId: 'runtime:other-mac'
    }
  }
  function host(fallback: string | null = 'folder:work') {
    return {
      resolveWorktree: vi.fn(async (id: string) => {
        const found = workspaces[id]
        if (!found) {
          throw new Error('That workspace is not available for session prep.')
        }
        return found
      }),
      defaultSourceWorktreeId: () => fallback
    }
  }
  async function clocked() {
    const directory = await mkdtemp(join(tmpdir(), 'prep-checked-'))
    directories.push(directory)
    const store = new SessionPrepStore(directory)
    const schedule = vi.fn()
    const clock = { now: 1_000 }
    let id = 0
    const requests = new SessionPrepRequests(
      store,
      () => clock.now,
      () => `batch-${++id}`,
      schedule
    )
    return { directory, store, schedule, clock, requests }
  }

  it('starts from the default Work folder when the pane workspace is unknown, and says so', async () => {
    const { directory, requests, schedule } = await clocked()
    expect(await requests.requestChecked(terminal, host())).toEqual({
      outcome: 'started',
      batchId: 'batch-1',
      startedIn: '/Users/me/Work'
    })
    expect(schedule).toHaveBeenCalledWith('batch-1')
    const saved = new SessionPrepStore(directory)
    await saved.load()
    expect(saved.list()[0]).toMatchObject({
      state: 'planning',
      source: { worktreeId: 'folder:work', paneKey: PANE },
      dropped: [expect.stringContaining('Started from /Users/me/Work')]
    })
  })

  it('records a visible failed batch with the real reason when nothing can start', async () => {
    const { directory, requests, schedule } = await clocked()
    const result = await requests.requestChecked(terminal, host(null))
    expect(result).toMatchObject({ outcome: 'not-started', batchId: 'batch-1' })
    expect(result.outcome === 'not-started' && result.reason).toContain(
      'No default Work folder is registered'
    )
    expect(schedule).not.toHaveBeenCalled()
    const saved = new SessionPrepStore(directory)
    await saved.load()
    expect(saved.list()[0]).toMatchObject({ state: 'failed', items: [] })
  })

  it('never moves a refused paired workspace to the local default', async () => {
    const { requests } = await clocked()
    const paired = { ...terminal, source: { ...terminal.source, worktreeId: 'folder:paired' } }
    const result = await requests.requestChecked(paired, host())
    expect(result.outcome).toBe('not-started')
    expect(result.outcome === 'not-started' && result.reason).toContain('paired Mac')
  })

  it('reuses the batch for the same words from the same pane, and retries a failed one in place', async () => {
    const { requests, schedule, clock, store } = await clocked()
    const first = await requests.requestChecked(terminal, host(null))
    expect(first.outcome).toBe('not-started')
    clock.now += 30_000
    expect(await requests.requestChecked(terminal, host())).toMatchObject({
      outcome: 'started',
      batchId: first.batchId
    })
    expect(await requests.requestChecked(terminal, host())).toEqual({
      outcome: 'already-requested',
      batchId: first.batchId
    })
    const otherPane = { ...terminal, source: { ...terminal.source, paneKey: 'tab-2:leaf-1' } }
    expect((await requests.requestChecked(otherPane, host())).batchId).toBe('batch-2')
    clock.now += 3 * 60_000
    expect((await requests.requestChecked(terminal, host())).batchId).toBe('batch-3')
    expect(schedule).toHaveBeenCalledTimes(3)
    expect(store.list()).toHaveLength(3)
  })

  it('does not report a request started when it could not be saved', async () => {
    const { requests, schedule, store } = await clocked()
    vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('disk full'))
    const result = await requests.requestChecked(terminal, host())
    expect(result).toMatchObject({ outcome: 'not-started' })
    expect(result.outcome === 'not-started' && result.reason).toContain('disk full')
    expect(schedule).not.toHaveBeenCalled()
  })
})
