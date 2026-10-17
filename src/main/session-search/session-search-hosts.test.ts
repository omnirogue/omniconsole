import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  environments: [] as { id: string; name: string }[],
  sshTargets: [] as { id: string; label: string }[],
  sshStates: {} as Record<string, string>,
  call: vi.fn(),
  sshSearch: vi.fn(),
  mux: vi.fn(),
  search: vi.fn()
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: mocks.mux,
  listRegisteredSshTargets: () => mocks.sshTargets,
  getRegisteredSshState: (id: string) =>
    mocks.sshStates[id] ? { status: mocks.sshStates[id] } : undefined
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => mocks.environments
}))
vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.call
}))
vi.mock('../local-host-label', () => ({ localHostLabel: () => 'mac-studio' }))
vi.mock('./session-search-service', () => ({
  getSessionSearchService: () => ({ search: mocks.search })
}))

import { remoteHitSchema } from './session-search-hit-schema'
import { searchSessionsOnHosts } from './session-search-hosts'
import {
  normalizeModelSummary,
  SUMMARY_MAX_CHARS,
  withRecordedLinks
} from './session-summary-prompt'

const hit = (sessionId: string, score: number) => ({
  sessionKey: `claude:${sessionId}`,
  sessionId,
  agent: 'claude',
  hostLabel: 'wrong',
  executionHostId: 'local',
  title: sessionId,
  cwd: null,
  transcriptPath: `/t/${sessionId}.jsonl`,
  lastActivityAt: 1,
  score,
  reasons: ['“uma” in 3 messages'],
  snippets: [],
  summary: null,
  summarySource: null
})

beforeEach(() => {
  mocks.environments = []
  mocks.sshTargets = []
  mocks.sshStates = {}
  mocks.sshSearch.mockReset().mockResolvedValue(null)
  mocks.mux.mockReset().mockReturnValue({ request: mocks.sshSearch, isDisposed: () => false })
  mocks.call.mockReset()
  mocks.search.mockReset()
  mocks.search.mockResolvedValue({
    hits: [hit('local-1', 5)],
    indexedSessions: 10,
    pendingFiles: 0,
    passes: 1
  })
})

describe('searchSessionsOnHosts', () => {
  it('merges paired hosts by score and stamps where each hit lives', async () => {
    mocks.environments = [{ id: 'env-1', name: 'mw0002' }]
    mocks.call.mockResolvedValue({
      ok: true,
      result: { hits: [hit('remote-1', 9)], hosts: [{ state: 'searched', indexedSessions: 4 }] }
    })
    const result = await searchSessionsOnHosts('/user-data', { query: 'uma' })
    expect(
      result.hits.map((entry) => [entry.sessionId, entry.hostLabel, entry.executionHostId])
    ).toEqual([
      ['remote-1', 'mw0002', 'runtime:env-1'],
      ['local-1', 'mac-studio', 'local']
    ])
    expect(mocks.call).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'sessionSearch.query',
      { query: 'uma', limit: 20, includeRemote: false, includeOwnedSsh: true },
      8000
    )
  })

  it('reports a host it cannot reach instead of treating it as having no matches', async () => {
    mocks.environments = [
      { id: 'env-1', name: 'mw0003' },
      { id: 'env-2', name: 'laptop' }
    ]
    mocks.call.mockRejectedValueOnce(new Error('connect ETIMEDOUT')).mockResolvedValueOnce({
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
    const result = await searchSessionsOnHosts('/user-data', { query: 'uma' })
    expect(result.hosts.map((host) => [host.hostLabel, host.state])).toEqual([
      ['mac-studio', 'searched'],
      ['mw0003', 'unreachable'],
      ['laptop', 'unsupported']
    ])
  })

  it('drops malformed remote hits and never asks paired hosts when told to stay local', async () => {
    mocks.environments = [{ id: 'env-1', name: 'mw0002' }]
    mocks.call.mockResolvedValue({
      ok: true,
      result: { hits: [{ sessionId: 'x' }, hit('ok', 1)], hosts: [] }
    })
    expect(
      (await searchSessionsOnHosts('/u', { query: 'q' })).hits.map((entry) => entry.sessionId)
    ).toEqual(['local-1', 'ok'])
    mocks.call.mockClear()
    await searchSessionsOnHosts('/u', { query: 'q', includeRemote: false })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it.each(['failed', 'unsupported', 'unreachable', 'indexing'])(
    'preserves a remote %s result even when the RPC succeeded',
    async (state) => {
      mocks.environments = [{ id: 'env-1', name: 'mw0002' }]
      mocks.call.mockResolvedValue({
        ok: true,
        result: { hits: [], hosts: [{ executionHostId: 'local', state, message: 'Not complete' }] }
      })
      const result = await searchSessionsOnHosts('/u', { query: 'q' })
      expect(result.hosts[1]).toMatchObject({ state, message: 'Not complete' })
    }
  )

  it.each([
    { hosts: [] },
    { hosts: [{ state: 'new-unknown-state' }] },
    { hosts: [{ executionHostId: 'runtime:another-host', state: 'searched' }] },
    { hosts: [{ state: 'searched' }, { state: 'searched' }] }
  ])('does not infer successful coverage from incomplete host evidence: %j', async ({ hosts }) => {
    mocks.environments = [{ id: 'env-1', name: 'mw0002' }]
    mocks.call.mockResolvedValue({ ok: true, result: { hits: [], hosts } })
    const result = await searchSessionsOnHosts('/u', { query: 'q' })
    expect(result.hosts[1]?.state).toBe('failed')
  })

  it('reports malformed successful replies as failed rather than unreachable', async () => {
    mocks.environments = [{ id: 'env-1', name: 'mw0002' }]
    mocks.call.mockResolvedValue({ ok: true, result: { hits: 'invalid', hosts: [] } })
    const result = await searchSessionsOnHosts('/u', { query: 'q' })
    expect(result.hosts[1]?.state).toBe('failed')
  })

  it('reports registered SSH coverage without connecting, and honors local-only scope', async () => {
    mocks.sshTargets = [
      { id: 'ssh-ready', label: 'mw0001' },
      { id: 'ssh-away', label: 'mw0003' },
      { id: 'ssh-unknown', label: 'mw0004' }
    ]
    mocks.sshStates = { 'ssh-ready': 'connected', 'ssh-away': 'disconnected' }
    const result = await searchSessionsOnHosts('/u', { query: 'q' })
    expect(result.hosts.map((host) => [host.executionHostId, host.state])).toEqual([
      ['local', 'searched'],
      ['ssh:ssh-ready', 'unsupported'],
      ['ssh:ssh-away', 'unreachable'],
      ['ssh:ssh-unknown', 'unreachable']
    ])
    const local = await searchSessionsOnHosts('/u', { query: 'q', includeRemote: false })
    expect(local.hosts.map((host) => host.executionHostId)).toEqual(['local'])
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('keeps paired coverage requests from indexing private SSH targets or displacing local hits', async () => {
    mocks.sshTargets = [{ id: 'ssh-ready', label: 'mw0001' }]
    mocks.sshStates = { 'ssh-ready': 'connected' }
    const result = await searchSessionsOnHosts('/u', {
      query: 'q',
      limit: 1,
      includeRemote: false,
      includeOwnedSsh: true
    })
    expect(result.hits.map((entry) => entry.sessionId)).toEqual(['local-1'])
    expect(result.ownedSshCoverage).toBe(true)
    expect(result.hosts.at(-1)).toMatchObject({
      state: 'unsupported',
      executionHostId: 'ssh:ssh-ready'
    })
    expect(mocks.sshSearch).not.toHaveBeenCalled()
  })
})

it('carries a paired controller’s SSH coverage without treating its private target as local', async () => {
  mocks.environments = [{ id: 'studio', name: 'Mac Studio' }]
  mocks.sshTargets = [{ id: 'same-id', label: 'A different local target' }]
  mocks.call.mockResolvedValue({
    ok: true,
    result: {
      hits: [
        hit('local-on-studio', 8),
        { ...hit('ssh-on-studio', 99), executionHostId: 'ssh:same-id' }
      ],
      ownedSshCoverage: true,
      hosts: [
        { executionHostId: 'local', state: 'searched' },
        { executionHostId: 'ssh:same-id', hostLabel: 'mw0002', state: 'unsupported' },
        { executionHostId: 'ssh:away', hostLabel: 'mw0003', state: 'unreachable' }
      ]
    }
  })
  const result = await searchSessionsOnHosts('/u', { query: 'q' })
  expect(result.hits.map((entry) => entry.sessionId)).toEqual(['local-on-studio', 'local-1'])
  expect(result.hosts.filter((host) => host.executionHostId === 'ssh:same-id')).toEqual([
    expect.objectContaining({
      ownerEnvironmentId: 'studio',
      coverage: 'owned-ssh',
      hostLabel: 'mw0002 (via Mac Studio)',
      state: 'unsupported'
    }),
    expect.objectContaining({ hostLabel: 'A different local target', state: 'unreachable' })
  ])
  expect(result.hosts.find((host) => host.executionHostId === 'ssh:away')).toMatchObject({
    state: 'unreachable',
    ownerEnvironmentId: 'studio'
  })
})

it('keeps older paired controller SSH coverage unknown even when its local search succeeds', async () => {
  mocks.environments = [{ id: 'studio', name: 'Mac Studio' }]
  mocks.call.mockResolvedValue({ ok: true, result: { hits: [], hosts: [{ state: 'searched' }] } })
  const result = await searchSessionsOnHosts('/u', { query: 'q' })
  expect(result.hosts).toContainEqual(
    expect.objectContaining({
      executionHostId: 'runtime:studio',
      coverage: 'owned-ssh',
      state: 'unsupported'
    })
  )
})

it('acknowledges an empty registered SSH inventory while refusing ambiguous inventory', async () => {
  mocks.environments = [{ id: 'studio', name: 'Mac Studio' }]
  const reply = {
    hits: [],
    ownedSshCoverage: true,
    hosts: [{ executionHostId: 'local', state: 'searched' }]
  }
  mocks.call.mockResolvedValue({ ok: true, result: reply })
  expect((await searchSessionsOnHosts('/u', { query: 'q' })).hosts).toHaveLength(2)
  reply.hosts.push(
    { executionHostId: 'ssh:duplicate', state: 'unsupported' },
    { executionHostId: 'ssh:duplicate', state: 'searched' }
  )
  const result = await searchSessionsOnHosts('/u', { query: 'q' })
  expect(result.hosts.at(-1)).toMatchObject({
    coverage: 'owned-ssh',
    state: 'unsupported',
    message: expect.stringContaining('ambiguous')
  })
})

it('answers an owned SSH coverage request without paired recursion or changing local-only queries', async () => {
  mocks.environments = [{ id: 'other', name: 'Other controller' }]
  mocks.sshTargets = [{ id: 'a/b', label: 'Worker' }]
  const result = await searchSessionsOnHosts('/u', {
    query: 'q',
    includeRemote: false,
    includeOwnedSsh: true
  })
  expect(result.ownedSshCoverage).toBe(true)
  expect(result.hosts.map((host) => host.executionHostId)).toEqual(['local', 'ssh:a%2Fb'])
  expect(mocks.call).not.toHaveBeenCalled()
  const local = await searchSessionsOnHosts('/u', { query: 'q', includeRemote: false })
  expect(local.ownedSshCoverage).toBeUndefined()
  expect(local.hosts).toHaveLength(1)
})

describe('SSH transcript content search', () => {
  beforeEach(() => {
    mocks.sshTargets = [{ id: 'worker/a', label: 'Worker Mac' }]
    mocks.sshStates = { 'worker/a': 'connected' }
  })
  it('queries the execution host and preserves the controller target identity', async () => {
    mocks.sshSearch.mockResolvedValue({
      supported: true,
      hits: [hit('remote', 9)],
      indexedSessions: 5,
      pendingFiles: 0,
      passes: 1
    })
    const result = await searchSessionsOnHosts('/u', { query: 'research' })
    expect(mocks.sshSearch).toHaveBeenCalledWith(
      'sessionSearch.query',
      { query: 'research', limit: 20 },
      { timeoutMs: 8000 }
    )
    expect(mocks.mux).toHaveBeenCalledWith('worker/a')
    expect(result.hits[0]).toMatchObject({
      sessionId: 'remote',
      hostLabel: 'Worker Mac',
      executionHostId: 'ssh:worker%2Fa'
    })
    expect(result.hosts.at(-1)).toMatchObject({ state: 'searched', indexedSessions: 5 })
  })
  it.each([
    { passes: 0, pendingFiles: 0 },
    { passes: 1, pendingFiles: 2 }
  ])('reports incomplete indexing without declaring an empty host: %j', async (progress) => {
    mocks.sshSearch.mockResolvedValue({
      supported: true,
      hits: [],
      indexedSessions: 0,
      ...progress
    })
    expect((await searchSessionsOnHosts('/u', { query: 'research' })).hosts.at(-1)?.state).toBe(
      'indexing'
    )
  })
  it('does not contact disconnected or unknown targets', async () => {
    mocks.sshStates = {}
    expect((await searchSessionsOnHosts('/u', { query: 'research' })).hosts.at(-1)?.state).toBe(
      'unreachable'
    )
    expect(mocks.sshSearch).not.toHaveBeenCalled()
  })
  it('does not accept results from a relay replaced during the request', async () => {
    mocks.sshSearch.mockImplementationOnce(async () => {
      mocks.mux.mockReturnValue({ request: vi.fn(), isDisposed: () => false })
      return {
        supported: true,
        hits: [hit('stale', 99)],
        indexedSessions: 1,
        pendingFiles: 0,
        passes: 1
      }
    })
    const result = await searchSessionsOnHosts('/u', { query: 'topic' })
    expect(result.hits.map((entry) => entry.sessionId)).toEqual(['local-1'])
    expect(result.hosts.at(-1)).toMatchObject({ state: 'failed' })
  })
  it('reports an older relay method error as unsupported', async () => {
    mocks.sshSearch.mockRejectedValueOnce({ code: -32601, message: 'Method not found' })
    const result = await searchSessionsOnHosts('/u', { query: 'topic' })
    expect(result.hosts.at(-1)).toMatchObject({ state: 'unsupported' })
  })
  it('keeps method absence, invalid replies and contact loss distinct', async () => {
    mocks.sshSearch
      .mockResolvedValueOnce({ supported: false })
      .mockResolvedValueOnce({ supported: true, hits: [] })
      .mockImplementationOnce(() => {
        mocks.sshStates = {}
        throw new Error('SSH relay disconnected')
      })
    for (const state of ['unsupported', 'failed', 'unreachable']) {
      expect((await searchSessionsOnHosts('/u', { query: 'research' })).hosts.at(-1)?.state).toBe(
        state
      )
    }
  })
  it('never restamps a foreign owner reply as this SSH host', async () => {
    mocks.sshSearch.mockResolvedValue({
      supported: true,
      hits: [{ ...hit('wrong-owner', 99), executionHostId: 'runtime:elsewhere' }],
      indexedSessions: 1,
      pendingFiles: 0,
      passes: 1
    })
    expect(
      (await searchSessionsOnHosts('/u', { query: 'research' })).hits.map((x) => x.sessionId)
    ).toEqual(['local-1'])
  })
})

// The longest summary this version stores: full core lines, Outcome and Links, then recorded links.
const pull = (n: number) => `https://github.com/omnirogue/omni-ide/pull/${n}`
const longSummary = withRecordedLinks(
  normalizeModelSummary(
    [
      'Title: Session outcome write side',
      ...['Goal', 'Done', 'Outputs', 'For', 'State', 'Next', 'Keywords'].map(
        (field) => `${field}: ${'word '.repeat(60)}`
      ),
      `Outcome: ${'y'.repeat(700)}`,
      `Links: ${Array.from({ length: 20 }, (_, i) => pull(1000 + i)).join(' ')}`
    ].join('\n')
  )!,
  Array.from({ length: 6 }, (_, i) => pull(2000 + i))
)

it.each(['paired', 'ssh'])('keeps a %s host summary whole, Links URLs included', async (via) => {
  expect(longSummary.length).toBeGreaterThan(2_000)
  expect(longSummary.endsWith(` ${pull(2000)}`)).toBe(true)
  mocks.search.mockResolvedValue({ hits: [], indexedSessions: 0, pendingFiles: 0, passes: 1 })
  const remote = { ...hit('long', 9), summary: longSummary, summarySource: 'model' }
  if (via === 'paired') {
    mocks.environments = [{ id: 'env-1', name: 'Mac Studio' }]
    mocks.call.mockResolvedValue({ ok: true, result: { hits: [remote], hosts: [] } })
  } else {
    mocks.sshTargets = [{ id: 'worker', label: 'Worker Mac' }]
    mocks.sshStates = { worker: 'connected' }
    mocks.sshSearch.mockResolvedValue({
      supported: true,
      hits: [remote],
      indexedSessions: 1,
      pendingFiles: 0,
      passes: 1
    })
  }
  const result = await searchSessionsOnHosts('/u', { query: 'outcome' })
  expect(result.hits.map((entry) => [entry.sessionId, entry.summary])).toEqual([
    ['long', longSummary]
  ])
})

it('admits the largest summary a host can store over the remote boundary', () => {
  const summary = 'z'.repeat(SUMMARY_MAX_CHARS + 600)
  expect(remoteHitSchema.parse({ ...hit('max', 1), summary }).summary).toBe(summary)
})
