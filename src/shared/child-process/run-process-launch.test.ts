import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from './run-process'

describe('process launch evidence', () => {
  it('publishes a real PID before delivering stdin', async () => {
    let pid: number | undefined
    let published = false
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      input: 'evidence-packet',
      onSpawn: (child) => {
        pid = child.pid
        published = true
      },
      onStdout: () => {
        expect(published).toBe(true)
      }
    })
    expect(pid).toBeGreaterThan(0)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('evidence-packet')
  })

  it.each([false, true])(
    'stops a child before rejecting a failed receipt callback (barrier=%s)',
    async (terminationBarrier) => {
      let terminated = false
      let pid: number | undefined
      await expect(
        runProcess({
          program: process.execPath,
          args: ['-e', 'process.stdin.pipe(process.stdout)'],
          input: 'must-not-be-delivered',
          terminationBarrier,
          onSpawn: (child) => {
            pid = child.pid
            throw new Error('receipt persistence failed')
          },
          onChildTerminated: () => {
            terminated = true
          }
        })
      ).rejects.toThrow('receipt persistence failed')
      expect(pid).toBeGreaterThan(0)
      expect(terminated).toBe(true)
      expect(() => process.kill(pid!, 0)).toThrow()
    }
  )

  it('does not publish a PID for a pre-cancelled launch', async () => {
    const controller = new AbortController()
    controller.abort()
    let published = false
    await runProcess({
      program: process.execPath,
      signal: controller.signal,
      onSpawn: () => {
        published = true
      }
    })
    expect(published).toBe(false)
  })
  it('refuses synchronous launch observation rather than silently omitting receipts', () => {
    expect(() => runProcessSync({ program: process.execPath, onSpawn: () => {} })).toThrow(
      'asynchronous runProcess'
    )
  })
})
