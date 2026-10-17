import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGraphChecker } from './graph-check'
import type { GraphCheckLanes } from './graph-check-lane'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan'

const call = {
  id: 'improve/r1/a0/check',
  check: {
    command: 'npm test',
    candidate: '```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```',
    scoreLastLine: true,
    apply: 'patch',
    prepare: 'npm ci',
    protect: ['tests/**']
  }
} as GraphCall

/** Private copies that record every request and never touch the disk. */
function spyLanes(acquire: () => Promise<{ path: string }> = async () => ({ path: tmpdir() })) {
  return {
    acquire: vi.fn(acquire),
    release: vi.fn(),
    discard: vi.fn(),
    dispose: vi.fn(async () => {})
  } as unknown as GraphCheckLanes & { acquire: ReturnType<typeof vi.fn> }
}

describe('a change to the code, replayed', () => {
  let dir = ''
  let store: GraphJevStore
  let starts: GraphJevStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-check-patch-replay-'))
    store = GraphJevStore.forExecution('exec-patch', dir, 'checks.json')
    starts = GraphJevStore.forExecution('exec-patch', dir, 'check-starts.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('never makes a private copy when only recorded results may be used', async () => {
    const lanes = spyLanes()
    const workspace = vi.fn(async () => dir)
    const replay = createGraphChecker({ store, starts, cacheOnly: true, lanes, workspace })
    await expect(replay(call)).rejects.toThrow('Check is not recorded')
    expect(lanes.acquire).not.toHaveBeenCalled()
    expect(workspace).not.toHaveBeenCalled()
    expect(starts.all()).toEqual({})
  })

  it("replays a recorded result without a copy, and a started one's receipt stops a second run", async () => {
    const lanes = spyLanes(async () => {
      throw new Error('no copy here')
    })
    const live = createGraphChecker({ store, starts, lanes })
    const first = await live(call)
    // The copy could not be made: unknown, never a pass, and recorded as such.
    expect(first).toMatchObject({ value: { passed: false, unavailable: true } })
    expect(lanes.acquire).toHaveBeenCalledTimes(1)
    const replay = createGraphChecker({ store, starts, cacheOnly: true, lanes })
    expect(await replay(call)).toEqual(first)
    expect(lanes.acquire).toHaveBeenCalledTimes(1)
    // A start with no result (the app stopped mid-check) is reported, never run again.
    store.remove(call.id)
    const resumed = await createGraphChecker({ store, starts, lanes })(call)
    expect(resumed).toMatchObject({ value: { passed: false, unavailable: true } })
    expect(JSON.stringify(resumed)).toContain('not run twice')
    expect(lanes.acquire).toHaveBeenCalledTimes(1)
  })

  it('never falls back to the workspace when the run has no private copies', async () => {
    const workspace = vi.fn(async () => dir)
    const result = await createGraphChecker({ store, starts, workspace })(call)
    expect(result).toMatchObject({ value: { passed: false, unavailable: true } })
    expect(JSON.stringify(result)).toContain('tested in a private copy')
    expect(workspace).not.toHaveBeenCalled()
  })

  it('forgets the start when Stop ends it while a copy is got ready', async () => {
    const abort = new AbortController()
    const lanes = spyLanes(async () => {
      abort.abort(new Error('Workflow stopped'))
      throw new Error('clone killed')
    })
    const live = createGraphChecker({ store, starts, lanes, signal: abort.signal })
    await expect(live(call)).rejects.toThrow('Workflow stopped')
    expect(starts.read(call.id)).toBeUndefined()
    expect(store.read(call.id)).toBeUndefined()
  })

  it('still runs a text version in the workspace, never in a copy', async () => {
    const lanes = spyLanes()
    const text = { id: 'improve/r1/a1/check', check: { command: 'npm test', candidate: 'v' } }
    const run = vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    }))
    const checker = createGraphChecker({ store, starts, run, lanes, workspace: async () => dir })
    expect(await checker(text as GraphCall)).toMatchObject({ value: { passed: true } })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }))
    expect(lanes.acquire).not.toHaveBeenCalled()
  })
})
