import { afterEach, expect, it, vi } from 'vitest'
const environmentState = vi.hoisted(() => ({ runtimeEnvironments: [] as { id: string }[] }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => environmentState } }))
vi.mock('@/lib/session-chain-support', () => ({
  LOCAL_CHAIN_TARGET: { kind: 'local' },
  workspaceRuntimeTarget: () => {
    throw new Error('Workspace has not hydrated')
  }
}))
vi.mock('@/components/next-step/next-step-summary', () => ({ describeSessionChainStrip: () => [] }))
import { remoteOutcomeFixture } from '../../src/main/runtime/session-outcome-remote-test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  commitSessionOutcomes,
  getOutcomeProgress,
  listSessionOutcomesForOwner,
  getOutcomeCapabilities
} from '@/components/next-step/next-step-outcome-client'
import {
  clearSessionChainEntries,
  getSessionChainEntry,
  setSessionChainEntry
} from '@/lib/session-chain-registry'
import { watchCommittedSessionOutcomes } from '@/lib/session-outcome-refresh'
import { sessionOutcomeProgress } from '../../src/shared/session-outcome-state'
import { sessionOutcomeChainForClient } from '../../src/shared/session-outcome-routing'

const hosts = new Map<string, Awaited<ReturnType<typeof remoteOutcomeFixture>>>()
const stops: (() => void)[] = []
const unavailable = new Set<string>()
const localCall = vi.fn()
const calls: { selector: string; method: string; params?: unknown }[] = []
afterEach(async () => {
  stops.splice(0).forEach((stop) => stop())
  for (const host of [...hosts.values()].toReversed()) {
    await host.dispose()
  }
  hosts.clear()
  unavailable.clear()
  calls.length = 0
  clearSessionChainEntries()
  environmentState.runtimeEnvironments = []
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
async function host(id: string, mode?: 'old' | 'missing') {
  const f = await remoteOutcomeFixture(mode)
  hosts.set(id, f)
  environmentState.runtimeEnvironments = [...hosts.keys()].map((id) => ({ id }))
  replaceRuntimeEnvironmentRevisions([...hosts.keys()].map((id) => ({ id, createdAt: 1 })))
  localCall.mockImplementation(async ({ method }: { method: string }) => ({
    ok: true,
    result:
      method === 'sessionChain.outcomeCapabilities'
        ? { version: 1, durableContinuation: true, executionRuntimeId: 'local' }
        : { chains: [] }
  }))
  vi.stubGlobal('window', {
    api: {
      runtime: { call: localCall },
      runtimeEnvironments: {
        call: async (args: { selector: string; method: string; params?: unknown }) => {
          calls.push(args)
          if (unavailable.has(args.selector)) {
            throw new Error('SSH tunnel unavailable')
          }
          const peer = hosts.get(args.selector)
          if (!peer) {
            throw new Error('Unknown peer')
          }
          return peer.connection.request(args.method, args.params, 5000)
        }
      }
    }
  })
  const owner = { kind: 'environment' as const, environmentId: id }
  return { ...f, owner, chain: sessionOutcomeChainForClient(f.chain, owner) }
}
async function complete(f: Awaited<ReturnType<typeof host>>) {
  f.host.service.dispose()
  for (let i = 0; i < 4; i++) {
    await f.host.service.tick()
    await f.host.settle()
  }
}

it('routes before hydration over actual paired transport, keeps a completed run sealed when it is edited and never calls local execution', async () => {
  const f = await host('peer')
  const saved = await commitSessionOutcomes({
    chain: f.chain,
    expectedRevision: 0,
    outcomes: [f.outcome]
  })
  expect(saved.hostId).toBe('runtime:peer')
  expect(saved.sourceRowKey).toBe(JSON.stringify(['runtime:peer', 'folder:outcome', 'source']))
  await complete(f)
  const done = await getOutcomeProgress(saved.id, f.owner)
  expect(done.lifecycle).toBe('complete')
  const edited = await commitSessionOutcomes({
    chain: done.chain,
    expectedRevision: 1,
    outcomes: [f.outcome, { ...f.outcome, id: 'second', actions: [], title: 'Second obligation' }]
  })
  // A completed run is sealed, so the edit is a new generation of the same source, never a
  // revision of the finished one: the seal, its proof and its conditions stay exactly as they were.
  expect(edited.id).not.toBe(saved.id)
  expect(edited.outcomeSet!.revision).toBe(1)
  expect(edited.outcomeSet!.outcomes.map((outcome) => outcome.id)).toContain('second')
  const sealed = await getOutcomeProgress(saved.id, f.owner)
  expect(sealed.lifecycle).toBe('complete')
  expect(sealed.chain.outcomeSet!.revision).toBe(1)
  expect(sealed.chain.outcomeSet!.completion).toEqual(done.chain.outcomeSet!.completion)
  expect(sealed.chain.outcomeSet!.outcomes[0]!.evidence).toEqual(
    done.chain.outcomeSet!.outcomes[0]!.evidence
  )
  expect(sealed.chain.outcomeSet!.outcomes[0]!.conditions).toEqual(
    done.chain.outcomeSet!.outcomes[0]!.conditions
  )
  expect(f.host.launched).toHaveLength(1)
  expect(localCall).not.toHaveBeenCalled()
  expect(
    calls
      .filter((call) => call.method === 'sessionChain.commitOutcomes')
      .every(
        (call) =>
          (call.params as { expectedExecutionRuntimeId: string }).expectedExecutionRuntimeId ===
          f.capabilities.executionRuntimeId
      )
  ).toBe(true)
})
it('hydrates two hosts with colliding chain/workspace IDs and restores cached completion after outage', async () => {
  const a = await host('a'),
    b = await host('b')
  for (const f of [a, b]) {
    await commitSessionOutcomes({ chain: f.chain, expectedRevision: 0, outcomes: [f.outcome] })
    await complete(f)
  }
  stops.push(watchCommittedSessionOutcomes(30))
  await vi.waitFor(() =>
    expect(getSessionChainEntry(a.chain.id, a.owner)?.chain.outcomeSet).toBeDefined()
  )
  await vi.waitFor(() =>
    expect(getSessionChainEntry(b.chain.id, b.owner)?.chain.outcomeSet).toBeDefined()
  )
  expect(getSessionChainEntry(a.chain.id)).toBeNull()
  await expect(getOutcomeProgress(a.chain.id)).rejects.toThrow('ambiguous')
  const polledA = (): number => calls.filter((call) => call.selector === 'a').length
  const beforeOutage = polledA()
  unavailable.add('a')
  // Two refused polls, so the outage has been handled in full at least once.
  await vi.waitFor(() => expect(polledA()).toBeGreaterThanOrEqual(beforeOutage + 2))
  // Sealed success is final: lost contact proves nothing against it, so the cached run stays
  // complete through the outage and is never anybody's needs-you.
  expect(
    sessionOutcomeProgress(getSessionChainEntry(a.chain.id, a.owner)!.chain.outcomeSet!)
  ).toMatchObject({ phase: 'completed', lifecycle: 'complete', attention: [] })
  expect(getSessionChainEntry(a.chain.id, a.owner)!.chain.outcomeSet!.continuation.state).toBe(
    'owned'
  )
  expect(
    sessionOutcomeProgress(getSessionChainEntry(b.chain.id, b.owner)!.chain.outcomeSet!).lifecycle
  ).toBe('complete')
  expect(a.host.service.get(a.chain.id).outcomeSet!.continuation.state).toBe('owned')
  unavailable.delete('a')
  await vi.waitFor(() =>
    expect(
      sessionOutcomeProgress(getSessionChainEntry(a.chain.id, a.owner)!.chain.outcomeSet!).lifecycle
    ).toBe('complete')
  )
  expect(a.host.launched).toHaveLength(1)
  expect(b.host.launched).toHaveLength(1)
})
it.each(['old', 'missing'] as const)(
  'refuses %s peer before writes and does not fall back to local',
  async (mode) => {
    const f = await host('old', mode)
    await expect(
      commitSessionOutcomes({ chain: f.chain, expectedRevision: 0, outcomes: [f.outcome] })
    ).rejects.toThrow()
    expect(f.host.runtime.listSessionChains()).toHaveLength(0)
    expect(localCall).not.toHaveBeenCalled()
  }
)
it('provides an owner-scoped list for Done checks before registry hydration and fences re-pair during probing', async () => {
  const f = await host('peer')
  const saved = await commitSessionOutcomes({
    chain: f.chain,
    expectedRevision: 0,
    outcomes: [f.outcome]
  })
  expect(getSessionChainEntry(saved.id)).toBeNull()
  expect(await listSessionOutcomesForOwner(f.owner)).toHaveLength(1)
  const original = window.api.runtimeEnvironments.call
  vi.spyOn(window.api.runtimeEnvironments, 'call').mockImplementation(async (args) => {
    const result = await original(args)
    if (args.method === 'sessionChain.outcomeCapabilities') {
      replaceRuntimeEnvironmentRevisions([{ id: 'peer', createdAt: 2 }])
    }
    return result
  })
  await expect(
    commitSessionOutcomes({ chain: saved, expectedRevision: 1, outcomes: [f.outcome] })
  ).rejects.toThrow('owner changed')
  expect(f.host.service.get(saved.id).outcomeSet!.revision).toBe(1)
})
it('refuses relay-only placement before any transport and cannot overwrite a newer edit with stale hydration', async () => {
  const f = await host('peer')
  await expect(getOutcomeCapabilities({ ...f.chain, placement: 'ssh:relay' })).rejects.toThrow(
    'Relay-only'
  )
  const saved = await commitSessionOutcomes({
    chain: f.chain,
    expectedRevision: 0,
    outcomes: [f.outcome]
  })
  setSessionChainEntry({ ...saved, outcomeSet: { ...saved.outcomeSet!, revision: 3 } })
  setSessionChainEntry(saved)
  expect(getSessionChainEntry(saved.id, f.owner)!.chain.outcomeSet!.revision).toBe(3)
})
