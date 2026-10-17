import { afterEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
const registry = vi.hoisted(() => ({
  entries: [] as { chain: { id: string; hostId: string; outcomeSet: unknown } }[]
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  hasRuntimeRpcErrorCode: (error: { code?: string }, code: string) => error.code === code
}))
vi.mock('@/lib/session-chain-registry', () => ({
  getSessionChainEntry: () => null,
  getAllSessionChainEntries: () => registry.entries
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
import {
  listSessionOutcomesForOwner,
  verifySessionOutcome,
  approveSessionOutcomeReview,
  chooseSessionOutcomeWait,
  commitSessionOutcomes,
  reconcileSessionOutcomes,
  reportSessionDisposition,
  retrySessionDisposition
} from './next-step-outcome-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type { SessionChain } from '../../../../shared/session-chain-types'
const owner = { kind: 'environment' as const, environmentId: 'peer' }
afterEach(() => {
  rpc.mockReset()
  registry.entries = []
  replaceRuntimeEnvironmentRevisions([])
})
it('allows legacy Done only after the same old host explicitly returns no outcomes', async () => {
  rpc
    .mockRejectedValueOnce(Object.assign(new Error('old method'), { code: 'method_not_found' }))
    .mockResolvedValueOnce({ chains: [] })
  expect(await listSessionOutcomesForOwner(owner)).toEqual([])
  expect(rpc.mock.calls.map((call) => [call[0], call[1]])).toEqual([
    [owner, 'sessionChain.outcomeCapabilities'],
    [owner, 'sessionChain.list']
  ])
})
it('does not treat transport failure or a missing previously committed obligation as a legacy empty set', async () => {
  rpc.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unavailable' }))
  await expect(listSessionOutcomesForOwner(owner)).rejects.toThrow('offline')
  expect(rpc).toHaveBeenCalledTimes(1)
  registry.entries = [
    { chain: { id: 'bound', hostId: 'runtime:peer', outcomeSet: { revision: 1 } } }
  ]
  rpc
    .mockResolvedValueOnce({ version: 1, durableContinuation: false })
    .mockResolvedValueOnce({ chains: [] })
  await expect(listSessionOutcomesForOwner(owner)).rejects.toThrow(
    'previously committed obligation'
  )
})
it('routes approval and verification by explicit owner with the negotiated incarnation and no owner metadata in payload', async () => {
  const capabilities = {
    version: 1,
    durableContinuation: true,
    remoteRuntimeOwnership: 1,
    placementScope: 'runtime-local',
    executionRuntimeId: 'incarnation'
  }
  const chain = {
    id: 'same-id',
    hostId: 'local',
    placement: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    worktreeId: 'folder:host',
    steps: []
  }
  rpc.mockImplementation(async (_target, method) =>
    method === 'sessionChain.outcomeCapabilities' ? capabilities : { chain }
  )
  const input = {
    id: 'same-id',
    owner,
    expectedRevision: 4,
    outcomeId: 'result',
    conditionId: 'proof'
  }
  await verifySessionOutcome(input)
  await approveSessionOutcomeReview({ ...input, version: 'current-bytes' })
  expect(
    rpc.mock.calls
      .filter((call) => call[1] !== 'sessionChain.outcomeCapabilities')
      .map((call) => call[2])
  ).toEqual([
    {
      id: 'same-id',
      expectedRevision: 4,
      outcomeId: 'result',
      conditionId: 'proof',
      expectedExecutionRuntimeId: 'incarnation'
    },
    {
      id: 'same-id',
      expectedRevision: 4,
      outcomeId: 'result',
      conditionId: 'proof',
      version: 'current-bytes',
      expectedExecutionRuntimeId: 'incarnation'
    }
  ])
  expect(rpc.mock.calls.every((call) => call[0].environmentId === 'peer')).toBe(true)
})

it("sends the owner's wait choice to the owning host under the negotiated incarnation", async () => {
  const capabilities = {
    version: 1,
    durableContinuation: true,
    remoteRuntimeOwnership: 1,
    placementScope: 'runtime-local',
    executionRuntimeId: 'incarnation'
  }
  const chain = { id: 'c', hostId: 'local', placement: 'local', sourcePaneKey: 's', steps: [] }
  rpc.mockImplementation(async (_target, method) =>
    method === 'sessionChain.outcomeCapabilities' ? capabilities : { chain }
  )
  await chooseSessionOutcomeWait({
    id: 'c',
    owner,
    expectedRevision: 3,
    outcomeId: 'approvals',
    conditionId: 'iris',
    choice: 'keep-waiting'
  })
  const call = rpc.mock.calls.find((entry) => entry[1] === 'sessionChain.chooseOutcomeWait')
  expect(call?.[2]).toEqual({
    id: 'c',
    expectedRevision: 3,
    outcomeId: 'approvals',
    conditionId: 'iris',
    choice: 'keep-waiting',
    expectedExecutionRuntimeId: 'incarnation'
  })
})
it('refuses an empty list crossing a runtime restart rather than permitting Done from stale negotiation', async () => {
  rpc
    .mockResolvedValueOnce({
      version: 1,
      durableContinuation: true,
      remoteRuntimeOwnership: 1,
      placementScope: 'runtime-local',
      executionRuntimeId: 'before'
    })
    .mockResolvedValueOnce({ chains: [] })
    .mockResolvedValueOnce({
      version: 1,
      durableContinuation: true,
      remoteRuntimeOwnership: 1,
      placementScope: 'runtime-local',
      executionRuntimeId: 'after'
    })
  await expect(listSessionOutcomesForOwner(owner)).rejects.toThrow('runtime changed while reading')
})

it('does not interpret malformed capability evidence as a legacy empty host', async () => {
  rpc.mockResolvedValueOnce(null)
  await expect(listSessionOutcomesForOwner(owner)).rejects.toThrow('unverifiable')
  expect(rpc).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'requires advertised source repair execution across paired hosts: %s',
  async (supported) => {
    const capabilities = {
      version: 1,
      durableContinuation: true,
      remoteRuntimeOwnership: 1,
      placementScope: 'runtime-local',
      executionRuntimeId: 'runtime',
      ...(supported ? { sourceReviewRepairs: 1 } : {})
    }
    const chain: SessionChain = {
      id: 'chain',
      hostId: 'runtime:peer',
      workspacePath: '/work',
      worktreeId: 'folder:work',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1,
      steps: [
        {
          id: 'review',
          agent: 'codex',
          prompt: 'Review',
          status: 'queued',
          review: {
            groupId: 'review',
            reviewerId: 'one',
            round: 1,
            maxRounds: 3,
            candidateVersion: 'candidate',
            repairWithSource: true
          }
        }
      ]
    }
    rpc.mockImplementation(async (_target, method) =>
      method === 'sessionChain.outcomeCapabilities'
        ? capabilities
        : { chain: { ...chain, hostId: 'local' } }
    )
    const result = commitSessionOutcomes({ chain, outcomes: [], expectedRevision: 0 })
    if (supported) {
      await expect(result).resolves.toMatchObject({ steps: chain.steps })
      expect(
        rpc.mock.calls.find((call) => call[1] === 'sessionChain.commitOutcomes')?.[2].chain.steps
      ).toEqual(chain.steps)
    } else {
      await expect(result).rejects.toThrow('Update the session execution host to repair findings')
      expect(rpc.mock.calls.some((call) => call[1] === 'sessionChain.commitOutcomes')).toBe(false)
    }
  }
)

const negotiated = {
  version: 1,
  durableContinuation: true,
  remoteRuntimeOwnership: 1,
  placementScope: 'runtime-local',
  executionRuntimeId: 'incarnation'
}
const sealedChain = {
  id: 'same-id',
  hostId: 'runtime:peer',
  placement: 'runtime:peer',
  sourcePaneKey: 'source',
  sourceRowKey: 'row',
  worktreeId: 'folder:host',
  steps: []
} as unknown as SessionChain

it('reports a disposition to the owning host under its operation id and the negotiated incarnation', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'sessionChain.outcomeCapabilities'
      ? negotiated
      : { chain: { ...sealedChain, hostId: 'local', placement: 'local' } }
  )
  await reportSessionDisposition({
    chain: sealedChain,
    operationId: 'op_seal',
    ok: false,
    error: 'The session is pinned or declined to close.'
  })
  await retrySessionDisposition(sealedChain)
  expect(
    rpc.mock.calls
      .filter((call) => call[1] !== 'sessionChain.outcomeCapabilities')
      .map((call) => [call[0], call[1], call[2]])
  ).toEqual([
    [
      owner,
      'sessionChain.reportDisposition',
      {
        chainId: 'same-id',
        operationId: 'op_seal',
        ok: false,
        error: 'The session is pinned or declined to close.',
        expectedExecutionRuntimeId: 'incarnation'
      }
    ],
    [
      owner,
      'sessionChain.retryDisposition',
      { chainId: 'same-id', expectedExecutionRuntimeId: 'incarnation' }
    ]
  ])
})

it('asks the owner to reconcile, and treats a host that predates it as nothing to do', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'sessionChain.outcomeCapabilities' ? negotiated : { reconciled: true }
  )
  await reconcileSessionOutcomes(owner)
  expect(rpc.mock.calls.at(-1)!.slice(0, 3)).toEqual([
    owner,
    'sessionChain.reconcile',
    { expectedExecutionRuntimeId: 'incarnation' }
  ])
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'sessionChain.outcomeCapabilities') {
      return negotiated
    }
    throw Object.assign(new Error('old method'), { code: 'method_not_found' })
  })
  await expect(reconcileSessionOutcomes(owner)).resolves.toBeUndefined()
  rpc.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }))
  await expect(reconcileSessionOutcomes(owner)).rejects.toThrow('offline')
})
