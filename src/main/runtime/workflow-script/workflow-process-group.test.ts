import { describe, expect, it } from 'vitest'
import { runWorkflowHelperProcess } from './workflow-process-group'

describe.skipIf(process.platform === 'win32')('workflow helper process cleanup', () => {
  it('does not return success while a child with closed output remains in its group', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(child.pid));
      child.unref();
    `
    const result = await runWorkflowHelperProcess({
      program: process.execPath,
      args: ['-e', script],
      timeoutMs: 3000,
      maxOutputBytes: 1024
    })
    expect(result.code).toBe(0)
    const descendant = Number(result.stdout)
    expect(descendant).toBeGreaterThan(0)
    if (process.platform === 'darwin') {
      expect(() => process.kill(descendant, 0)).toThrow()
    }
  })

  it('keeps cancellation and output behavior for ordinary commands', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runWorkflowHelperProcess({
      program: process.execPath,
      args: ['-e', 'throw new Error("must not start")'],
      signal: controller.signal
    })
    expect(result.code).toBeNull()
    expect(result.stdout).toBe('')
  })
})
