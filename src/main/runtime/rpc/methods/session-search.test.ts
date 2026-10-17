import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../omni-runtime'

const { searchSessionsOnHosts } = vi.hoisted(() => ({ searchSessionsOnHosts: vi.fn() }))
vi.mock('../../../session-search/session-search-hosts', () => ({ searchSessionsOnHosts }))
vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/user-data'
}))

import { SESSION_SEARCH_METHODS } from './session-search'

const dispatcher = new RpcDispatcher({
  runtime: { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService,
  methods: SESSION_SEARCH_METHODS
})
const request = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'sessionSearch.query',
  params
})

beforeEach(() => {
  searchSessionsOnHosts.mockReset()
  searchSessionsOnHosts.mockResolvedValue({ query: 'uma', hits: [], hosts: [], tookMs: 1 })
})

describe('sessionSearch.query', () => {
  it('searches this host and its paired hosts for a local caller', async () => {
    const response = await dispatcher.dispatch(request({ query: ' uma ', limit: 5 }))
    expect(response.ok).toBe(true)
    expect(searchSessionsOnHosts).toHaveBeenCalledWith('/user-data', {
      query: 'uma',
      limit: 5,
      includeRemote: true,
      includeOwnedSsh: false
    })
  })

  it('answers a paired client for this host only, so fan-out cannot loop', async () => {
    await dispatcher.dispatch(request({ query: 'uma', includeRemote: true }), {
      clientKind: 'runtime'
    } as never)
    expect(searchSessionsOnHosts).toHaveBeenCalledWith('/user-data', {
      query: 'uma',
      limit: undefined,
      includeRemote: false,
      includeOwnedSsh: false
    })
  })

  it('rejects an empty or oversized query', async () => {
    expect((await dispatcher.dispatch(request({ query: '   ' }))).ok).toBe(false)
    expect((await dispatcher.dispatch(request({ query: 'x'.repeat(600) }))).ok).toBe(false)
    expect(searchSessionsOnHosts).not.toHaveBeenCalled()
  })
})

it('allows paired callers to request only controller-owned SSH coverage without fan-out', async () => {
  await dispatcher.dispatch(request({ query: 'q', includeRemote: true, includeOwnedSsh: true }), {
    clientKind: 'runtime'
  } as never)
  expect(searchSessionsOnHosts).toHaveBeenCalledWith('/user-data', {
    query: 'q',
    limit: undefined,
    includeRemote: false,
    includeOwnedSsh: true
  })
})
