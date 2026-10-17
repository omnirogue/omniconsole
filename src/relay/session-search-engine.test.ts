import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn(), shutdown: vi.fn() }))
vi.mock('../main/session-search/session-search-engine', () => ({
  createSessionSearchEngine: mocks.create
}))
import { createRelaySessionSearch } from './session-search-engine'

beforeEach(() => {
  vi.spyOn(process, 'getBuiltinModule').mockReturnValue({ DatabaseSync: class {} } as never)
  mocks.create.mockReset().mockReturnValue({ execute: mocks.execute, shutdown: mocks.shutdown })
  mocks.execute.mockReset().mockReturnValue({
    hits: [],
    indexedSessions: 3,
    pendingFiles: 2,
    passes: 0,
    lastPassAt: null,
    modelLoaded: false
  })
  mocks.shutdown.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('relay content search uses the existing index engine', () => {
  it('defers index startup until search and reuses one engine for later requests', () => {
    const search = createRelaySessionSearch('/worker/home')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(search.search({ query: 'remote topic', limit: 4 })).toMatchObject({
      supported: true,
      passes: 0,
      pendingFiles: 2
    })
    search.search({ query: 'another topic', limit: 2 })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        homeDir: '/worker/home',
        dutyCycle: 0.25
      })
    )
    expect(dirname(mocks.create.mock.calls[0]![0].dbPath)).toBe(
      join(dirname(mocks.create.mock.calls[0]![0].modelDir), 'session-search')
    )
    expect(mocks.execute).toHaveBeenLastCalledWith({
      type: 'request',
      id: 0,
      op: 'search',
      query: 'another topic',
      limit: 2
    })
    search.shutdown()
    expect(mocks.shutdown).toHaveBeenCalledTimes(1)
  })
  it('isolates indexes across relay sockets while reusing a socket cache after child retirement', () => {
    const first = createRelaySessionSearch('/worker/home', '/relay/a.sock')
    first.search({ query: 'topic', limit: 1 })
    first.shutdown()
    createRelaySessionSearch('/worker/home', '/relay/b.sock').search({ query: 'topic', limit: 1 })
    createRelaySessionSearch('/worker/home', '/relay/a.sock').search({ query: 'topic', limit: 1 })
    const paths = mocks.create.mock.calls.map(([config]) => config.dbPath)
    expect(paths[0]).not.toBe(paths[1])
    expect(paths[0]).toBe(paths[2])
  })
  it('leaves older Node companions usable without opening a database', () => {
    vi.mocked(process.getBuiltinModule).mockReturnValue(undefined as never)
    expect(
      createRelaySessionSearch('/worker/home').search({ query: 'topic', limit: 1 })
    ).toMatchObject({ supported: false })
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it('treats a missing builtin error as unsupported instead of taking down the history service', () => {
    vi.mocked(process.getBuiltinModule).mockImplementation(() => {
      throw new Error('unknown builtin')
    })
    expect(
      createRelaySessionSearch('/worker/home').search({ query: 'topic', limit: 1 }).supported
    ).toBe(false)
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
