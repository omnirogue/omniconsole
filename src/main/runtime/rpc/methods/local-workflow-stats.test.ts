import { describe, expect, it, vi } from 'vitest'
import { LOCAL_WORKFLOW_METHODS } from '../../../../shared/local-workflow-rpc'
import type { RpcContext, RpcMethod } from '../core'

vi.mock('../../workflow-script/workflow-discover-stats', () => ({
  readDiscoverStats: vi.fn(() => ({ runs: 0 }))
}))

vi.mock('../../workflow-script/workflow-judging-stats', () => ({
  workflowJudgingStats: vi.fn(async (request: unknown) => ({ request, groups: [] }))
}))
vi.mock('../../workflow-script/discover-omnios-decision-stats', () => ({
  discoverDecisionStats: vi.fn(() => ({ runs: 1 }))
}))
vi.mock(import('../../../../shared/app-environment'), async (original) => ({
  ...(await original()),
  getAppEnvironment: () => ({ getPath: () => '/user-data' }) as never
}))

import { workflowJudgingStats } from '../../workflow-script/workflow-judging-stats'
import { discoverDecisionStats } from '../../workflow-script/discover-omnios-decision-stats'
// Why: the runtime module settles the method table's import cycle before this method loads.
import '../../omni-runtime'
import { LOCAL_WORKFLOW_RPC_METHODS } from './local-workflow'

const method = LOCAL_WORKFLOW_RPC_METHODS.find(
  (entry) => entry.name === LOCAL_WORKFLOW_METHODS.stats
) as RpcMethod

describe('localWorkflow.stats', () => {
  it('sums up this host’s own judging record for a local caller, changing nothing', async () => {
    const params = method.params!.parse({ template: 'council', since: 5 })
    await expect(
      method.handler(params, {
        runtime: { getOrchestrationDb: () => ({ db: {} }) }
      } as unknown as RpcContext)
    ).resolves.toEqual({
      request: { template: 'council', since: 5 },
      groups: [],
      discover: { runs: 0 },
      decisions: { runs: 1 }
    })
    expect(workflowJudgingStats).toHaveBeenCalledWith({ template: 'council', since: 5 })
    expect(workflowJudgingStats).toHaveBeenCalledTimes(1)
    // The acted-on rate comes from this computer's Discover pages, under the same filters.
    expect(discoverDecisionStats).toHaveBeenCalledWith(expect.stringContaining('discover-omnios'), {
      template: 'council',
      since: 5
    })
  })

  it('refuses a paired device or a mobile client, and a request it does not know', async () => {
    const params = method.params!.parse({})
    await expect(method.handler(params, { clientKind: 'mobile' } as RpcContext)).rejects.toThrow(
      'desktop runtime'
    )
    await expect(method.handler(params, { pairedDeviceId: 'phone' } as RpcContext)).rejects.toThrow(
      'desktop runtime'
    )
    for (const request of [{ since: -1 }, { since: 1.5 }, { template: '' }, { root: '/x' }]) {
      expect(() => method.params!.parse(request)).toThrow()
    }
  })
})
