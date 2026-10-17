import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import {
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_STRUCTURED_OUTPUT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { callRuntimeRpc, getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import {
  createAutomationForDestination,
  updateAutomationForOwner,
  resetAutomationCapabilityProbes
} from './automation-scoped-list-client'
import { updateAutomationForTarget } from './automation-host-client'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn()
}))

const authority = { kind: 'runtime', environmentId: 'host', pairingRevision: 4 } as const
const owner = { authority, selector: { kind: 'self' } } as const
const destination = { selector: { kind: 'self' } } as const
const input: AutomationCreateInput = {
  name: 'Daily',
  prompt: 'Work',
  agentId: 'codex',
  projectId: 'repo',
  workspaceMode: 'new_per_run',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1
}
const structuredOutput = { provider: 'typesafe', contract: 'classification.v1' } as const

beforeEach(() => {
  vi.resetAllMocks()
  resetAutomationCapabilityProbes()
  vi.mocked(callRuntimeRpc).mockResolvedValue({ automation: { id: 'routine' } })
})

describe('routine structured-output mixed-version negotiation', () => {
  it('refuses create, update and clear before an older host can silently drop the option', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue({
      capabilities: [AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY]
    } as Awaited<ReturnType<typeof getRuntimeEnvironmentStatus>>)
    await expect(
      createAutomationForDestination(authority, { ...input, structuredOutput }, destination)
    ).rejects.toThrow('Structured decisions require a newer')
    await expect(updateAutomationForOwner(owner, 'routine', { structuredOutput })).rejects.toThrow(
      'Structured decisions require a newer'
    )
    await expect(
      updateAutomationForOwner(owner, 'routine', { structuredOutput: null })
    ).rejects.toThrow('Structured decisions require a newer')
    await expect(
      updateAutomationForTarget(
        { id: 'routine' } as Automation,
        { structuredOutput },
        {
          kind: 'environment',
          environmentId: 'host'
        }
      )
    ).rejects.toThrow('Structured decisions require a newer')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('preserves ordinary create and update behavior against the same older host', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue({
      capabilities: [AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY]
    } as Awaited<ReturnType<typeof getRuntimeEnvironmentStatus>>)
    await createAutomationForDestination(authority, input, destination)
    await updateAutomationForOwner(owner, 'routine', { name: 'Renamed' })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('forwards the option only after the owning host advertises support', async () => {
    vi.mocked(getRuntimeEnvironmentStatus).mockResolvedValue({
      capabilities: [
        AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
        AUTOMATION_STRUCTURED_OUTPUT_RUNTIME_CAPABILITY
      ]
    } as Awaited<ReturnType<typeof getRuntimeEnvironmentStatus>>)
    await createAutomationForDestination(authority, { ...input, structuredOutput }, destination)
    await updateAutomationForOwner(owner, 'routine', { structuredOutput: null })
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'host' },
      'automation.create',
      expect.objectContaining({ structuredOutput }),
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'host' },
      'automation.update',
      expect.objectContaining({ updates: { structuredOutput: null } }),
      expect.objectContaining({ expectedEnvironmentPairingRevision: 4 })
    )
  })
})
