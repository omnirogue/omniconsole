// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem, ArtifactMetadata } from '../../../../shared/artifacts'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), toast: [] as { kind: string; args: unknown[] }[] }))
const AUTH = vi.hoisted(() => ({
  state: 'connected',
  activeProfileId: 'profile-a',
  cloud: { userId: 'user-a', cloudProfileId: 'cloud-a' }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ orcaProfileAuthStatus: AUTH }) }
}))
vi.mock('@/lib/open-linked-session', () => ({ openLinkedSession: vi.fn() }))
vi.mock('sonner', () => ({
  toast: Object.fromEntries(
    ['success', 'error', 'message', 'dismiss'].map((kind) => [
      kind,
      (...args: unknown[]) => mocks.toast.push({ kind, args })
    ])
  )
}))

import type { OrcaProfileAuthStatus } from '../../../../shared/omni-profiles'
import type { ArtifactListFilter } from './artifact-list-filter'
import { deriveArtifactRowStatus } from './artifact-lifecycle-model'
import { useArtifactLifecycleActions } from './use-artifact-lifecycle-actions'
import { useArtifactPagination } from './useArtifactPagination'

function row(slug: string, extra: Partial<ArtifactMetadata> = {}): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug,
      title: `Page ${slug}`,
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
      expiresAt: '2026-12-01T00:00:00Z',
      byteSize: 1,
      deletedAt: null,
      revision: 3,
      review: { question: 'Ship?', reviewers: [], status: 'pending', statusAt: null },
      lifecycle: null,
      closedAt: null,
      closedRef: null,
      supersededBy: null,
      supersededAt: null,
      ...extra
    },
    shareUrl: `https://omnios.example/a/${slug}`,
    needsYou: true,
    lastDecision: null,
    sessionRef: null,
    sessionAgent: null
  }
}

const list = (rows: ArtifactListItem[], nextCursor?: string) => ({
  status: 'ok',
  value: { artifacts: rows, ...(nextCursor ? { nextCursor } : {}) }
})
const statusDoc = (artifact: ArtifactMetadata) => ({
  status: 'ok',
  value: { artifact, shareUrl: '', status: 'pending', latest: null, decisions: [], viewer: {} }
})
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => (resolve = yes))
  return { promise, resolve }
}
const refreshAuth = async (): Promise<void> => undefined
const confirm = async (): Promise<boolean> => true

function usePage(initialChecked: string[] = []) {
  const [filter, setFilter] = useState<ArtifactListFilter>('all')
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set(initialChecked))
  const pagination = useArtifactPagination(AUTH as OrcaProfileAuthStatus, refreshAuth, filter)
  const actions = useArtifactLifecycleActions({
    identity: pagination.accountIdentity,
    artifacts: pagination.artifacts,
    replaceArtifact: pagination.replaceArtifact,
    sessionLinks: new Map(),
    checkedSlugs: checked,
    clearChecked: () => setChecked(new Set()),
    confirm
  })
  return { ...pagination, actions, setFilter, setChecked }
}

const flush = () => act(async () => undefined)
const lifecycleCalls = () =>
  mocks.rpc.mock.calls.filter(([, method]) => method === 'artifacts.lifecycle')

describe('artifact lifecycle hooks', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.toast.length = 0
  })
  afterEach(cleanup)

  it('R1: a single-row Reopen re-reads the viewer state, so the row needs you again', async () => {
    let server = row('a')
    mocks.rpc.mockImplementation(async (_t, method, params) => {
      if (method === 'artifacts.list') {
        return list([server])
      }
      const closing = params.body.action === 'close'
      server = {
        ...server,
        needsYou: !closing,
        artifact: {
          ...server.artifact,
          lifecycle: closing ? 'no_action' : null,
          closedAt: closing ? 't1' : null
        }
      }
      return statusDoc(server.artifact)
    })
    const { result } = renderHook(() => usePage())
    await flush()
    await act(async () =>
      result.current.actions.handlers.run(result.current.artifacts[0], 'noAction')
    )
    await flush()
    expect(deriveArtifactRowStatus(result.current.artifacts[0]).kind).toBe('no_action')
    await act(async () =>
      result.current.actions.handlers.run(result.current.artifacts[0], 'reopen')
    )
    await flush()
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'artifacts.list', {
      state: 'needs_me'
    })
    expect(deriveArtifactRowStatus(result.current.artifacts[0]).kind).toBe('needs_you')
  })

  it('R2: a Refresh started before a Mark done cannot bring the open row back', async () => {
    const open = row('a')
    const stale = deferred<unknown>()
    let reads = 0
    mocks.rpc.mockImplementation(async (_t, method) =>
      method === 'artifacts.list'
        ? ++reads === 1
          ? list([open])
          : stale.promise
        : statusDoc({ ...open.artifact, lifecycle: 'no_action', closedAt: 't1' })
    )
    const { result } = renderHook(() => usePage())
    await flush()
    await act(async () => void result.current.loadArtifacts())
    await act(async () =>
      result.current.actions.handlers.run(result.current.artifacts[0], 'noAction')
    )
    await flush()
    expect(result.current.artifacts[0].artifact.lifecycle).toBe('no_action')
    await act(async () => stale.resolve(list([open, row('b')])))
    await flush()
    expect(
      result.current.artifacts.map((item) => [item.artifact.slug, item.artifact.lifecycle])
    ).toEqual([
      ['a', 'no_action'],
      ['b', null]
    ])
  })

  it('R3: Load more during a filter restart never sends the old filter cursor', async () => {
    const closedFirstPage = deferred<unknown>()
    mocks.rpc.mockImplementation(async (_t, _method, params) => {
      if (!params.state) {
        return list([row('a')], 'all-page-2')
      }
      return params.cursor ? list([row('z')]) : closedFirstPage.promise
    })
    const { result } = renderHook(() => usePage())
    await flush()
    expect(result.current.nextCursor).toBe('all-page-2')
    await act(async () => result.current.setFilter('closed'))
    expect(result.current.nextCursor).toBeUndefined()
    await act(async () => result.current.loadMoreArtifacts())
    expect(mocks.rpc.mock.calls.some(([, , params]) => params?.cursor === 'all-page-2')).toBe(false)
    await act(async () =>
      closedFirstPage.resolve(list([row('c', { lifecycle: 'done' })], 'closed-2'))
    )
    await flush()
    expect(result.current.nextCursor).toBe('closed-2')
    await act(async () => result.current.loadMoreArtifacts())
    expect(mocks.rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'artifacts.list', {
      cursor: 'closed-2',
      state: 'closed'
    })
  })

  it('R6: Undo shares the in-flight cap and blocks a new bulk action until it ends', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(String(index)))
    let hang = false
    let inFlight = 0
    let peak = 0
    mocks.rpc.mockImplementation(async (_t, method, params) => {
      if (method === 'artifacts.list') {
        return list(rows)
      }
      if (hang) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        return new Promise(() => undefined)
      }
      const found = rows.find((item) => item.artifact.slug === params.id)!
      return statusDoc({ ...found.artifact, lifecycle: 'no_action', closedAt: 't1' })
    })
    const { result } = renderHook(() => usePage(['0', '1', '2', '3']))
    await flush()
    await act(async () => result.current.actions.runBulk('no_action'))
    await flush()
    const undo = mocks.toast.find((entry) => (entry.args[1] as { action?: unknown })?.action)
    const { onClick } = (undo!.args[1] as { action: { onClick: () => void } }).action
    hang = true
    await act(async () => onClick())
    expect(result.current.actions.undoRunning).toBe(true)
    expect(result.current.actions.handlers.busy('0')).toBe(true)
    await act(async () => result.current.setChecked(new Set(['4', '5', '6', '7'])))
    await act(async () => result.current.actions.runBulk('no_action'))
    await flush()
    expect(peak).toBe(4)
    expect(lifecycleCalls()).toHaveLength(8)
  })
})
