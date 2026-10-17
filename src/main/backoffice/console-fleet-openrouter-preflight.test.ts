import { expect, it, vi } from 'vitest'
import { validateFleetOmpAdmission } from './console-fleet-openrouter-preflight'
import { requireFleetReconciliation } from './console-fleet-reconciliation'
import { createConversationFleetClientFixture } from './conversation-fleet-client-test-fixture'
vi.mock('./console-fleet-reconciliation', () => ({
  requireFleetReconciliation: vi.fn().mockResolvedValue({ ok: true, data: null })
}))
it('does not substitute fresh host availability for accepted replay proof', async () => {
  const { admission } = createConversationFleetClientFixture()
  admission.graph.nodes[0].provider = 'omp'
  admission.graph.nodes[0].actor_id = 'omp:openrouter/vendor/exact'
  admission.graph.nodes[0].model = 'openrouter/vendor/exact'
  admission.graph.nodes[0].openrouter_candidates = ['vendor/exact', 'vendor/second']
  const readInventory = vi
    .fn()
    .mockResolvedValue({ ok: false, error: { code: 'offline', message: 'Host is unavailable' } })
  const person = { principal: 'person', isCurrent: () => true }
  expect(await validateFleetOmpAdmission(admission, readInventory, person, true)).toMatchObject({
    ok: true
  })
  expect(readInventory).not.toHaveBeenCalled()
  expect(requireFleetReconciliation).toHaveBeenCalledWith(
    admission.taskId,
    person.principal,
    person.isCurrent
  )
  expect(await validateFleetOmpAdmission(admission, readInventory, person, false)).toMatchObject({
    ok: false
  })
  expect(readInventory).toHaveBeenCalledTimes(1)
})
