import { afterEach, expect, it, vi } from 'vitest'
const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: exec }))
import { readRecentDriftSubjects } from './drift-subject-read'
import { GitCommandTimeoutError } from './command-runner/git-command-timeout'

afterEach(() => {
  vi.useRealTimers()
  exec.mockReset()
})

it('keeps a completed empty log distinct from an unknown read', async () => {
  exec.mockResolvedValue({ stdout: '' })
  await expect(readRecentDriftSubjects('/repo', 'HEAD', 'origin/main', 5)).resolves.toEqual({
    status: 'known',
    subjects: []
  })
  exec.mockRejectedValue(new Error('unavailable'))
  await expect(readRecentDriftSubjects('/repo', 'HEAD', 'origin/main', 5)).resolves.toEqual({
    status: 'unknown'
  })
})

it('keeps a hung subject read unknown after the runner timeout at fifteen seconds', async () => {
  vi.useFakeTimers()
  exec.mockImplementation(
    (_args, options) =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new GitCommandTimeoutError(options.timeout)), options.timeout)
      })
  )
  const read = readRecentDriftSubjects('/repo', 'HEAD', 'origin/main', 5, { wslDistro: 'Ubuntu' })
  expect(exec).toHaveBeenCalledExactlyOnceWith(
    ['log', '--format=%s', '-n', '5', 'HEAD..origin/main'],
    { cwd: '/repo', wslDistro: 'Ubuntu', timeout: 15000 }
  )
  expect(exec.mock.calls[0][1]).not.toHaveProperty('signal')
  const settled = vi.fn()
  void read.then(settled)
  await vi.advanceTimersByTimeAsync(5000)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10000)
  await expect(read).resolves.toEqual({ status: 'unknown' })
  expect(vi.getTimerCount()).toBe(0)
})
