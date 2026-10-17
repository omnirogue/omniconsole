import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  sessionOutcomeChainForHost,
  requireSessionOutcomeHost
} from '../../shared/session-outcome-routing'
import type { SessionChain } from '../../shared/session-chain-types'
import { remoteOutcomeFixture } from './session-outcome-remote-test-fixture'

const fixtures: Awaited<ReturnType<typeof remoteOutcomeFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0).toReversed()) {
    await f.dispose()
  }
})
async function fixture() {
  const f = await remoteOutcomeFixture()
  fixtures.push(f)
  return f
}
const target = { kind: 'environment' as const, environmentId: 'tunnel' }

it('commits over actual paired E2EE transport to host persistence, continues while disconnected, and never replays a completed action', async () => {
  const f = await fixture()
  const runtimeId = requireSessionOutcomeHost(f.capabilities, target)
  const input = {
    chain: sessionOutcomeChainForHost(f.chain, target),
    outcomes: [f.outcome],
    source: 'user',
    expectedRevision: 0,
    expectedExecutionRuntimeId: runtimeId
  }
  const committed = await f.connection.request<{ chain: SessionChain }>(
    'sessionChain.commitOutcomes',
    input,
    5000
  )
  expect(committed).toMatchObject({
    ok: true,
    result: { chain: { hostId: 'local', outcomeSet: { revision: 1 } } }
  })
  const disk = JSON.parse(readFileSync(join(f.host.workspace, '.omni', 'state.json'), 'utf8'))
  expect(disk.sessionChains[0].outcomeSet.revision).toBe(1)
  f.connection.close()
  f.host.service.dispose()
  for (let i = 0; i < 4; i++) {
    await f.host.service.tick()
    await f.host.settle()
  }
  expect(f.host.launched).toHaveLength(1)
  const reconnected = f.connect()
  const progress = await reconnected.request(
    'sessionChain.outcomeProgress',
    { id: f.chain.id, expectedExecutionRuntimeId: runtimeId },
    5000
  )
  expect(progress).toMatchObject({ ok: true, result: { lifecycle: 'complete' } })
  const replay = await reconnected.request('sessionChain.commitOutcomes', input, 5000)
  expect(replay).toMatchObject({ ok: false })
  await f.host.service.tick()
  expect(f.host.launched).toHaveLength(1)
})

it('rejects missing/wrong negotiated runtime and relay-backed work even when the payload claims local placement', async () => {
  const f = await fixture()
  const input = {
    chain: sessionOutcomeChainForHost(f.chain, target),
    outcomes: [f.outcome],
    source: 'user',
    expectedRevision: 0
  }
  await expect(
    f.connection.request('sessionChain.commitOutcomes', input, 5000)
  ).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('Negotiate') } })
  await expect(
    f.connection.request(
      'sessionChain.commitOutcomes',
      { ...input, expectedExecutionRuntimeId: 'another-host' },
      5000
    )
  ).resolves.toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('runtime changed') }
  })
  vi.mocked(f.host.runtime.getSessionOutcomeExecutionScope).mockResolvedValue({
    path: f.host.workspace,
    connectionId: 'relay-target'
  })
  await expect(
    f.connection.request(
      'sessionChain.commitOutcomes',
      { ...input, expectedExecutionRuntimeId: f.capabilities.executionRuntimeId },
      5000
    )
  ).resolves.toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('Relay-only SSH') }
  })
  expect(f.host.runtime.listSessionChains()).toHaveLength(0)
  expect(f.host.launched).toHaveLength(0)
})

it('reconciles a lost commit reply by reading the same durable host set before retrying', async () => {
  const f = await fixture()
  const write = f.host.persistence.replaceSessionChainOutcomesAndFlush.bind(f.host.persistence)
  vi.mocked(f.host.runtime.replaceSessionChainOutcomesAndFlush).mockImplementation(
    (chain, revision) => {
      const saved = write(chain, revision)
      f.connection.close(new Error('Simulated SSH tunnel loss after host fsync'))
      return saved
    }
  )
  const input = {
    chain: sessionOutcomeChainForHost(f.chain, target),
    outcomes: [f.outcome],
    source: 'user',
    expectedRevision: 0,
    expectedExecutionRuntimeId: f.capabilities.executionRuntimeId
  }
  await expect(f.connection.request('sessionChain.commitOutcomes', input, 5000)).rejects.toThrow(
    'tunnel loss'
  )
  expect(f.host.runtime.listSessionChains()[0]!.outcomeSet!.revision).toBe(1)
  vi.mocked(f.host.runtime.replaceSessionChainOutcomesAndFlush).mockImplementation(
    (chain, revision) => f.host.persistence.replaceSessionChainOutcomesAndFlush(chain, revision)
  )
  f.host.service.dispose()
  for (let i = 0; i < 4; i++) {
    await f.host.service.tick()
    await f.host.settle()
  }
  const again = f.connect()
  await expect(
    again.request(
      'sessionChain.outcomeProgress',
      { id: f.chain.id, expectedExecutionRuntimeId: f.capabilities.executionRuntimeId },
      5000
    )
  ).resolves.toMatchObject({ ok: true, result: { lifecycle: 'complete' } })
  expect(f.host.launched).toHaveLength(1)
})

it.each(['old', 'missing'] as const)(
  'refuses %s host capability over actual transport before any write',
  async (mode) => {
    const f = await remoteOutcomeFixture(mode)
    fixtures.push(f)
    expect(() => requireSessionOutcomeHost(f.capabilities, target)).toThrow()
    expect(f.host.runtime.listSessionChains()).toHaveLength(0)
    expect(f.host.launched).toHaveLength(0)
  }
)

it('projects lost contact as unverifiable without mutating host persistence or repeating work', async () => {
  const { sessionOutcomeUnverifiableChain } = await import('../../shared/session-outcome-routing')
  const { sessionOutcomeProgress } = await import('../../shared/session-outcome-state')
  const f = await fixture()
  const result = await f.connection.request<{ chain: SessionChain }>(
    'sessionChain.commitOutcomes',
    {
      chain: sessionOutcomeChainForHost(f.chain, target),
      outcomes: [f.outcome],
      source: 'user',
      expectedRevision: 0,
      expectedExecutionRuntimeId: f.capabilities.executionRuntimeId
    },
    5000
  )
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  const cached = result.result.chain
  f.connection.close()
  await f.server.stop()
  await expect(
    f
      .connect()
      .request(
        'sessionChain.outcomeProgress',
        { id: f.chain.id, expectedExecutionRuntimeId: f.capabilities.executionRuntimeId },
        1000
      )
  ).rejects.toThrow()
  const observation = sessionOutcomeUnverifiableChain(cached)
  // Lost contact proves nothing about the work: the run waits for its host and asks nobody.
  expect(sessionOutcomeProgress(observation.outcomeSet!)).toMatchObject({
    phase: 'waiting',
    lifecycle: 'waiting',
    attention: [],
    reasons: expect.arrayContaining(['Execution host continuation is unverifiable.'])
  })
  expect(cached.outcomeSet!.continuation.state).toBe('owned')
  expect(f.host.runtime.listSessionChains()[0]!.outcomeSet!.continuation.state).toBe('owned')
  f.host.service.dispose()
  for (let i = 0; i < 4; i++) {
    await f.host.service.tick()
    await f.host.settle()
  }
  expect(f.host.launched).toHaveLength(1)
})

it('reloads the actual host profile and SQLite receipts in a new runtime without replaying effects', async () => {
  const f = await fixture()
  const input = {
    chain: sessionOutcomeChainForHost(f.chain, target),
    outcomes: [f.outcome],
    source: 'user',
    expectedRevision: 0,
    expectedExecutionRuntimeId: f.capabilities.executionRuntimeId
  }
  await expect(
    f.connection.request('sessionChain.commitOutcomes', input, 5000)
  ).resolves.toMatchObject({ ok: true })
  f.host.service.dispose()
  for (let i = 0; i < 4; i++) {
    await f.host.service.tick()
    await f.host.settle()
  }
  expect(f.host.launched).toHaveLength(1)
  f.connection.close()
  await f.server.stop()
  await f.host.service.suspend()
  f.host.closeDatabase()
  const restored = await remoteOutcomeFixture(
    undefined,
    f.host.workspace,
    Number(new URL(f.pairing.endpoint).port)
  )
  const samePairing = restored.connect(f.pairing)
  fixtures.push(restored)
  expect(restored.capabilities.executionRuntimeId).not.toBe(f.capabilities.executionRuntimeId)
  await expect(
    samePairing.request(
      'sessionChain.outcomeProgress',
      { id: f.chain.id, expectedExecutionRuntimeId: f.capabilities.executionRuntimeId },
      5000
    )
  ).resolves.toMatchObject({ ok: false })
  const current = await samePairing.request(
    'sessionChain.outcomeProgress',
    { id: f.chain.id, expectedExecutionRuntimeId: restored.capabilities.executionRuntimeId },
    5000
  )
  expect(current).toMatchObject({ ok: true, result: { lifecycle: 'complete' } })
  await restored.host.service.tick()
  await restored.host.service.tick()
  expect(restored.host.launched).toHaveLength(0)
  expect(restored.host.runtime.listSessionChains()[0]!.outcomeSet!.attempts).toHaveLength(1)
})

it('accepts a paired runtime user review only on the negotiated owning runtime and current bytes', async () => {
  const f = await fixture()
  f.host.write('result.txt', 'reviewed host bytes')
  const outcome = {
    ...f.outcome,
    finish: 'my-review',
    actions: [],
    conditions: [...f.outcome.conditions, { id: 'review', kind: 'review', target: 'host result' }]
  }
  await expect(
    f.connection.request(
      'sessionChain.commitOutcomes',
      {
        chain: sessionOutcomeChainForHost(f.chain, target),
        outcomes: [outcome],
        source: 'user',
        expectedRevision: 0,
        expectedExecutionRuntimeId: f.capabilities.executionRuntimeId
      },
      5000
    )
  ).resolves.toMatchObject({ ok: true })
  f.host.service.dispose()
  await f.host.service.tick()
  const version = f.host.service
    .get(f.chain.id)
    .outcomeSet!.outcomes[0]!.conditions.find((entry) => entry.kind === 'review')!.version
  const input = {
    id: f.chain.id,
    expectedRevision: 1,
    outcomeId: 'result',
    conditionId: 'review',
    version,
    expectedExecutionRuntimeId: f.capabilities.executionRuntimeId
  }
  await expect(
    f.connection.request(
      'sessionChain.approveOutcomeReview',
      { ...input, expectedExecutionRuntimeId: 'another-runtime' },
      5000
    )
  ).resolves.toMatchObject({ ok: false })
  await expect(
    f.connection.request('sessionChain.approveOutcomeReview', input, 5000)
  ).resolves.toMatchObject({ ok: true, result: { chain: { state: 'done' } } })
  expect(f.host.launched).toHaveLength(0)
})

it('refuses nested source binding from the actual persisted outcome child dispatch after it completes', async () => {
  const { sessionOutcomeMutationAuthority } = await import('./session-outcome-authority')
  const f = await fixture()
  await expect(
    f.connection.request(
      'sessionChain.commitOutcomes',
      {
        chain: sessionOutcomeChainForHost(f.chain, target),
        outcomes: [f.outcome],
        source: 'user',
        expectedRevision: 0,
        expectedExecutionRuntimeId: f.capabilities.executionRuntimeId
      },
      5000
    )
  ).resolves.toMatchObject({ ok: true })
  f.host.service.dispose()
  for (let i = 0; i < 4; i++) {
    await f.host.service.tick()
    await f.host.settle()
  }
  const attempt = f.host.service.get(f.chain.id).outcomeSet!.attempts[0]!
  const worker = f.host.db.getWorkerDispatch(attempt.dispatchId!)!
  expect(worker.state).toBe('succeeded')
  vi.mocked(f.host.runtime.resolveTerminalPane).mockReturnValue({
    handle: worker.agent_terminal_handle!,
    tabId: 'child',
    leafId: 'leaf',
    ptyId: 'pty',
    connected: true,
    worktreeId: 'folder:outcome'
  })
  expect(() =>
    sessionOutcomeMutationAuthority(
      { runtime: f.host.runtime, orchestrationCapability: 'child-envelope' },
      { ...f.chain, sourcePaneKey: 'child' },
      'ai'
    )
  ).toThrow('nested source binding')
  expect(f.host.runtime.listSessionChains()).toHaveLength(1)
  expect(f.host.launched).toHaveLength(1)
})
