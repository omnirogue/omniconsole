import { expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { writeAutomationDelivery } from './automation-delivery-operations'

it('advances the history revision for the claim and final receipt even within one millisecond', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100)
  const automation = { id: 'routine', updatedAt: 100 } as Automation
  const other = { id: 'other', updatedAt: 100 } as Automation
  const run = { id: 'run', automationId: 'routine', status: 'completed' } as AutomationRun
  const state = { automations: [automation, other], automationRuns: [run] } as PersistedState
  const durable: PersistedState[] = []
  const flush = async () => {
    durable.push(structuredClone(state))
  }
  const claim = {
    automationId: 'routine',
    runId: 'run',
    phase: 'execution' as const,
    claimId: 'claim'
  }
  try {
    await writeAutomationDelivery(state, flush, claim)
    const results = [{ kind: 'chat' as const, target: 'run', ok: true }]
    await writeAutomationDelivery(state, flush, { ...claim, results })

    expect(durable.map((snapshot) => snapshot.automations[0].updatedAt)).toEqual([101, 102])
    expect(durable[1].automationRuns[0]).toMatchObject({
      status: 'completed',
      deliveryResults: results
    })
    expect(state.automations[1]).toBe(other)
    expect(automation.updatedAt).toBe(100)
    await expect(writeAutomationDelivery(state, flush, claim)).resolves.toMatchObject({
      acquired: false
    })
    expect(durable).toHaveLength(2)
    expect(state.automations[0].updatedAt).toBe(102)
  } finally {
    now.mockRestore()
  }
})
