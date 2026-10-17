import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({ list: vi.fn(), reconcile: vi.fn() }))
const registry = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(() => []),
  set: vi.fn(),
  publish: vi.fn()
}))
const state = vi.hoisted(() => ({ runtimeEnvironments: [] as { id: string }[] }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/components/next-step/next-step-outcome-client', () => ({
  listSessionOutcomesForOwner: host.list,
  reconcileSessionOutcomes: host.reconcile
}))
vi.mock('./session-outcome-owner', () => ({
  // A target (`kind`) or a chain's host (`hostId`), as the real key reads both.
  outcomeOwnerKey: (owner: { kind?: string; environmentId?: string; hostId?: string }) =>
    owner.kind === 'local' || owner.hostId === 'local'
      ? 'local'
      : `environment:${owner.environmentId ?? owner.hostId}`
}))
vi.mock('./session-chain-registry', () => ({
  getSessionChainEntry: registry.get,
  getAllSessionChainEntries: registry.all,
  setSessionChainEntry: registry.set,
  publishSessionChains: registry.publish,
  subscribeSessionChains: () => () => {}
}))
import { watchCommittedSessionOutcomes } from './session-outcome-refresh'
beforeEach(() => {
  host.reconcile.mockResolvedValue(undefined)
  registry.all.mockReturnValue([])
  registry.get.mockReturnValue(undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  state.runtimeEnvironments = []
})
describe('owner-scoped outcome observation lifecycle', () => {
  it('hydrates known environments before workspaces load while another owner is unavailable', async () => {
    state.runtimeEnvironments = [{ id: 'peer' }]
    const chain = { id: 'remote', outcomeSet: { revision: 1 } }
    host.list.mockImplementation((owner: { kind: string }) =>
      owner.kind === 'local' ? new Promise(() => {}) : Promise.resolve([chain])
    )
    const stop = watchCommittedSessionOutcomes()
    await vi.waitFor(() => expect(registry.set).toHaveBeenCalledWith(chain))
    expect(host.list).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'peer' })
    stop()
  })
  it('ignores an owner response arriving after the view detached', async () => {
    let resolve!: (chains: unknown[]) => void
    host.list.mockReturnValue(
      new Promise((accept) => {
        resolve = accept
      })
    )
    const stop = watchCommittedSessionOutcomes()
    stop()
    resolve([{ id: 'bound', outcomeSet: { revision: 1 } }])
    await Promise.resolve()
    await Promise.resolve()
    expect(registry.set).not.toHaveBeenCalled()
  })
  it('retries an unavailable host without clearing the registry', async () => {
    vi.useFakeTimers()
    host.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
    const stop = watchCommittedSessionOutcomes(50)
    await vi.advanceTimersByTimeAsync(50)
    expect(host.list).toHaveBeenCalledTimes(2)
    expect(registry.set).not.toHaveBeenCalled()
    stop()
  })
})

it('continues polling a healthy owner while a different owner never answers', async () => {
  vi.useFakeTimers()
  state.runtimeEnvironments = [{ id: 'peer' }]
  host.list.mockImplementation((owner: { kind: string }) =>
    owner.kind === 'local' ? new Promise(() => {}) : Promise.resolve([])
  )
  const stop = watchCommittedSessionOutcomes(20)
  await vi.advanceTimersByTimeAsync(45)
  expect(host.list.mock.calls.filter((call) => call[0].kind === 'environment')).toHaveLength(3)
  stop()
})

describe('terminal evidence and reconnects', () => {
  const owned = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    hostId: 'local',
    outcomeSet: { revision: 1, continuation: { state: 'owned' }, ...extra }
  })
  const seal = { at: 1, outcomes: [{ id: 'result', revision: 1 }], evidenceIds: [] }

  it('an outage never projects a sealed run as unverifiable; only unfinished work loses contact', async () => {
    const sealed = owned('sealed', { completion: seal })
    const running = owned('running')
    registry.all.mockReturnValue([{ chain: sealed }, { chain: running }] as never)
    host.list.mockRejectedValue(new Error('offline'))
    const stop = watchCommittedSessionOutcomes()
    await vi.waitFor(() => expect(registry.publish).toHaveBeenCalled())
    stop()
    expect(registry.set).toHaveBeenCalledTimes(1)
    expect(registry.set).toHaveBeenCalledWith({
      ...running,
      outcomeSet: { ...running.outcomeSet, continuation: { state: 'unverifiable' } }
    })
  })

  it('reconnect hydration cannot replace a seal this view already read with an unsealed copy', async () => {
    const sealed = owned('chain', { completion: seal })
    registry.get.mockReturnValue({ chain: sealed })
    host.list.mockResolvedValue([owned('chain')])
    const stop = watchCommittedSessionOutcomes()
    await vi.waitFor(() => expect(host.reconcile).toHaveBeenCalled())
    await Promise.resolve()
    stop()
    expect(registry.set).not.toHaveBeenCalled()
    expect(registry.publish).not.toHaveBeenCalled()
  })

  it('asks the host to converge on first contact and again after every reconnect, not on every poll', async () => {
    vi.useFakeTimers()
    host.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([])
    const stop = watchCommittedSessionOutcomes(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(host.reconcile).toHaveBeenCalledTimes(1)
    expect(host.reconcile).toHaveBeenCalledWith({ kind: 'local' })
    await vi.advanceTimersByTimeAsync(50)
    expect(host.reconcile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(host.reconcile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(host.list).toHaveBeenCalledTimes(4)
    expect(host.reconcile).toHaveBeenCalledTimes(2)
    stop()
  })

  it('a host that cannot reconcile never reads as an outage', async () => {
    host.reconcile.mockRejectedValue(new Error('reconcile failed'))
    const running = owned('running')
    registry.all.mockReturnValue([{ chain: running }] as never)
    host.list.mockResolvedValue([running])
    registry.get.mockReturnValue({ chain: running })
    const stop = watchCommittedSessionOutcomes()
    await vi.waitFor(() => expect(host.reconcile).toHaveBeenCalled())
    await Promise.resolve()
    stop()
    expect(registry.set).not.toHaveBeenCalled()
  })
})
