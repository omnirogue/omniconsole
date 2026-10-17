import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionPrepBatchRecord } from './session-prep-records'
import { SessionPrepStore } from './session-prep-store'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'session-prep-store-'))
}

function batch(
  id: string,
  createdAt: number,
  state: SessionPrepBatchRecord['state'] = 'done'
): SessionPrepBatchRecord {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    state,
    source: { worktreeId: 'repo::/src', paneKey: 'pane-1', agent: 'claude' },
    request: 'create sessions',
    context: '',
    dropped: [],
    items: []
  }
}

describe('SessionPrepStore', () => {
  const dirs: string[] = []
  afterEach(async () => {
    dirs.length = 0
  })

  it('round-trips a batch through batches.json', async () => {
    const directory = await tempDir()
    dirs.push(directory)
    const store = new SessionPrepStore(directory)
    await store.load()
    store.upsert(batch('sp_one', 10, 'running'))
    await store.persist()
    const raw = JSON.parse(await readFile(join(directory, 'batches.json'), 'utf8')) as {
      version: number
      batches: SessionPrepBatchRecord[]
    }
    expect(raw.version).toBe(1)
    expect(raw.batches[0]?.id).toBe('sp_one')
    const reloaded = new SessionPrepStore(directory)
    await reloaded.load()
    expect(reloaded.get('sp_one')?.state).toBe('running')
  })

  it('keeps a batch added while the file is still loading', async () => {
    const directory = await tempDir()
    const first = new SessionPrepStore(directory)
    first.upsert(batch('from-disk', 1))
    await first.persist()
    const store = new SessionPrepStore(directory)
    const loading = store.load()
    store.upsert(batch('arrived-mid-load', 2, 'planning'))
    await loading
    expect(store.get('from-disk')).toBeDefined()
    expect(store.get('arrived-mid-load')?.state).toBe('planning')
  })

  it('keeps 50 batches by dropping the oldest terminal first', async () => {
    const directory = await tempDir()
    const store = new SessionPrepStore(directory)
    await store.load()
    for (let index = 0; index < 51; index += 1) {
      store.upsert(batch(`sp_${index}`, index, 'done'))
    }
    await store.persist()
    expect(store.list()).toHaveLength(50)
    expect(store.get('sp_0')).toBeUndefined()
    expect(store.get('sp_50')).toBeDefined()
  })

  it('does not drop in-flight batches to satisfy the cap', async () => {
    const directory = await tempDir()
    const store = new SessionPrepStore(directory)
    await store.load()
    for (let index = 0; index < 51; index += 1) {
      store.upsert(batch(`sp_${index}`, index, 'running'))
    }
    await store.persist()
    expect(store.list()).toHaveLength(51)
  })

  it('quarantines a corrupt file and starts empty', async () => {
    const directory = await tempDir()
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'batches.json'), '{not json', 'utf8')
    const store = new SessionPrepStore(directory)
    await store.load()
    expect(store.list()).toEqual([])
    const names = await readdir(directory)
    expect(names.some((name) => name.startsWith('batches.corrupt-'))).toBe(true)
  })

  it('coalesces concurrent persists into serialized writes', async () => {
    const directory = await tempDir()
    const store = new SessionPrepStore(directory)
    await store.load()
    store.upsert(batch('sp_a', 1))
    const first = store.persist()
    store.upsert(batch('sp_b', 2))
    const second = store.persist()
    await Promise.all([first, second])
    const reloaded = new SessionPrepStore(directory)
    await reloaded.load()
    expect(
      reloaded
        .list()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['sp_a', 'sp_b'])
  })
})
