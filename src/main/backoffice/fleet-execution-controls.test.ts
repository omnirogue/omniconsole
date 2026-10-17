import type * as Transport from './console-workflow-transport'
import { describe, expect, it, vi } from 'vitest'
import { fleetExecutionControlsAvailable } from '../../shared/fleet-execution-controls'
import { consoleWorkflowControlClient } from './console-workflow-control-client'

vi.mock('./console-workflow-transport', async (original) => ({
  ...(await original<typeof Transport>()),
  requestConsoleWorkflow: vi.fn(() => {
    throw new Error('Unsafe control reached network')
  })
}))

describe('fleet controls without deployed execution acknowledgement', () => {
  it('refuses cancellation and retry before network even when invoked directly', async () => {
    expect(fleetExecutionControlsAvailable).toBe(false)
    for (const response of await Promise.all([
      consoleWorkflowControlClient.cancelWorkflow({ workflowId: 'wf_test' }),
      consoleWorkflowControlClient.cancelJob({ jobId: 'job_test' }),
      consoleWorkflowControlClient.retryJob({ jobId: 'job_test' })
    ])) {
      expect(response).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
    }
  })
})
