import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

const { spawn, signalTree, exec } = vi.hoisted(() => ({
  spawn: vi.fn(),
  signalTree: vi.fn(),
  exec: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFile: spawn }))
vi.mock('./command-runner/spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: signalTree
}))
vi.mock('./runner', () => ({ gitExecFileAsync: exec }))
import { execFileCapture } from './command-runner/exec-file-capture'
import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  invalidateGitUpstreamStatusReads()
})

it('kills the subprocess tree, reports termination, and frees the upstream owner after its deadline', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    kill: vi.fn(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  }) as unknown as ChildProcess
  spawn.mockReturnValue(child)
  signalTree.mockImplementation(async () => {
    child.emit('close', null, 'SIGTERM')
    return true
  })
  const released = vi.fn()
  exec.mockImplementation((args, options) =>
    execFileCapture('git', args, {
      ...options,
      encoding: 'utf-8',
      onChildTerminated: released
    })
  )
  const pending = getUpstreamStatus('/repo')
  await vi.advanceTimersByTimeAsync(4999)
  expect(signalTree).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).resolves.toMatchObject({ upstreamStatusUnknown: true })
  expect(signalTree).toHaveBeenCalledWith(child)
  expect(released).toHaveBeenCalledOnce()
  exec.mockResolvedValue({ stdout: '', stderr: '' })
  await expect(getUpstreamStatus('/repo')).resolves.toMatchObject({ hasUpstream: false })
  expect(exec.mock.calls.length).toBeGreaterThan(1)
  expect(vi.getTimerCount()).toBe(0)
})
