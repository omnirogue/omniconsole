import { expect, it, vi } from 'vitest'
import { UP_NEXT_RPC } from '../../../../shared/up-next-types'
import { conversationId, harness } from './up-next-harness'
import { SESSION_CHAIN_CAPABILITIES_METHOD } from './session-chain-capabilities'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
vi.mock('../../conversation-readiness', () => ({
  observeConversationReadiness: async () => ({ ready: false, unverifiable: false })
}))

function pairedHost(seed?: Parameters<typeof harness>[1]) {
  const host = harness(
    { clientId: undefined, clientKind: 'runtime', pairedDeviceId: 'device-a' },
    seed
  )
  const scope = vi.fn(
    async (): Promise<{
      path: string
      connectionId: string | null
      wslDistro: string | null
    }> => ({ path: '/w', connectionId: null, wslDistro: null })
  )
  Object.assign(host.ctx.runtime, {
    getRuntimeId: () => 'runtime-a',
    getSessionOutcomeExecutionScope: scope
  })
  return { ...host, scope }
}

const requests = [
  [UP_NEXT_RPC.list, {}],
  [UP_NEXT_RPC.append, { draft: { kind: 'prompt', text: 'Continue here' } }],
  [UP_NEXT_RPC.update, { blockId: 'b', patch: { kind: 'prompt', text: 'Updated' } }],
  [UP_NEXT_RPC.reorder, { blockId: 'b', direction: -1 }],
  [UP_NEXT_RPC.remove, { blockId: 'b' }],
  [UP_NEXT_RPC.commit, {}],
  [UP_NEXT_RPC.discardDrafts, {}],
  [UP_NEXT_RPC.configureAfter, { blockId: 'b' }]
] as const

it.each(requests)(
  'fences paired %s before observing or mutating the conversation',
  async (method, extra) => {
    const host = pairedHost()
    for (const expectedExecutionRuntimeId of [undefined, 'different-runtime']) {
      await expect(
        host.call(method, { conversationId, ...extra, expectedExecutionRuntimeId })
      ).rejects.toThrow(
        expectedExecutionRuntimeId ? 'execution runtime changed' : 'Negotiate outcome ownership'
      )
    }
    expect(host.scope).not.toHaveBeenCalled()
    expect(host.flushed()).toBe(0)
    expect(host.commits).toHaveLength(0)
    expect(host.queue()).toBeNull()
  }
)

it('retains paired drafts across reconnect and flushes their committed removal', async () => {
  const host = pairedHost()
  const params = { conversationId, expectedExecutionRuntimeId: 'runtime-a' }
  await host.call(UP_NEXT_RPC.append, { ...params, draft: { kind: 'prompt', text: 'Stay on A' } })
  const read = await host.call(UP_NEXT_RPC.list, params)
  expect(read.view.blocks).toEqual([expect.objectContaining({ text: 'Stay on A', state: 'draft' })])
  const restored = pairedHost({ state: structuredClone(host.state) })
  expect((await restored.call(UP_NEXT_RPC.list, params)).view.blocks).toEqual(read.view.blocks)
  await restored.call(UP_NEXT_RPC.commit, params)
  // Draft composition is debounced; committed removal must be flushed before acknowledgment.
  expect(restored.flushed()).toBe(1)
  expect(restored.queue()?.entries).toEqual([expect.objectContaining({ text: 'Stay on A' })])
  expect(restored.drafts()).toBeNull()
  const reopened = pairedHost({ state: structuredClone(restored.state) })
  expect(reopened.queue()?.entries).toEqual(restored.queue()?.entries)
  expect(reopened.drafts()).toBeNull()
})

it.each(['ssh', 'wsl'] as const)(
  'refuses a peer that only relays the %s conversation',
  async (kind) => {
    const host = pairedHost()
    host.scope.mockResolvedValue({
      path: '/w',
      connectionId: kind === 'ssh' ? 'relay' : null,
      wslDistro: kind === 'wsl' ? 'Ubuntu' : null
    })
    await expect(
      host.call(UP_NEXT_RPC.append, {
        conversationId,
        expectedExecutionRuntimeId: 'runtime-a',
        draft: { kind: 'prompt', text: 'No fallback' }
      })
    ).rejects.toThrow(kind === 'ssh' ? 'Relay-only SSH' : 'WSL')
    expect(host.flushed()).toBe(0)
  }
)

it('advertises the fence only with the implementation that enforces it', async () => {
  const host = pairedHost()
  expect(await SESSION_CHAIN_CAPABILITIES_METHOD.handler(undefined, host.ctx)).toMatchObject({
    upNextRemoteOwnership: 1,
    executionRuntimeId: 'runtime-a'
  })
})

it('keeps local clients compatible without an execution-runtime field', async () => {
  const host = harness()
  await expect(
    host.call(UP_NEXT_RPC.append, {
      conversationId,
      draft: { kind: 'prompt', text: 'Local client' }
    })
  ).resolves.toMatchObject({ view: { draftCount: 1 } })
})
