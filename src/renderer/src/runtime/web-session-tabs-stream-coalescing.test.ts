import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  createWebSessionTabsStreamCoalescer,
  WEB_SESSION_TABS_UPDATE_FLUSH_MS
} from './web-session-tabs-stream-coalescing'

function frame(result: unknown): RuntimeRpcResponse<unknown> {
  return {
    id: 'subscription-event',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-test' }
  }
}

function updated(
  worktree: string,
  snapshotVersion: number,
  extra: object = {}
): RuntimeRpcResponse<unknown> {
  return frame({
    type: 'updated',
    worktree,
    snapshotVersion,
    tabs: [],
    ...extra
  })
}

const versionsOf = (deliver: ReturnType<typeof vi.fn>): string[] =>
  deliver.mock.calls.map(([response]) => {
    const { ok, result } = response as RuntimeRpcResponse<unknown> & {
      result?: Record<string, unknown>
    }
    if (ok === false || !result) {
      return 'error::'
    }
    return `${String(result.type)}:${String(result.worktree ?? '')}:${String(result.snapshotVersion ?? '')}`
  })

describe('createWebSessionTabsStreamCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies a spinner burst as the first frame now and only the newest one later (repro)', () => {
    const deliver = vi.fn()
    const coalescer = createWebSessionTabsStreamCoalescer(deliver)

    // Repro: a remote spinner-in-title agent flipped a worktree's frame ~12×/s and
    // every flip re-rendered the window. The burst must cost one apply per window.
    for (let version = 1; version <= 12; version++) {
      coalescer.offer(updated('wt-a', version))
      vi.advanceTimersByTime(80)
    }
    expect(versionsOf(deliver)).toEqual([
      'updated:wt-a:1',
      'updated:wt-a:4',
      'updated:wt-a:7',
      'updated:wt-a:10'
    ])

    vi.advanceTimersByTime(WEB_SESSION_TABS_UPDATE_FLUSH_MS)
    expect(versionsOf(deliver)).toEqual([
      'updated:wt-a:1',
      'updated:wt-a:4',
      'updated:wt-a:7',
      'updated:wt-a:10',
      'updated:wt-a:12'
    ])
  })

  it('flushes every pending worktree in one tick', () => {
    const deliver = vi.fn()
    const coalescer = createWebSessionTabsStreamCoalescer(deliver)

    coalescer.offer(updated('wt-a', 1))
    coalescer.offer(updated('wt-b', 1))
    vi.advanceTimersByTime(10)
    coalescer.offer(updated('wt-a', 2))
    coalescer.offer(updated('wt-b', 2))
    coalescer.offer(updated('wt-a', 3))
    expect(versionsOf(deliver)).toEqual(['updated:wt-a:1', 'updated:wt-b:1'])

    vi.advanceTimersByTime(WEB_SESSION_TABS_UPDATE_FLUSH_MS - 10)
    expect(versionsOf(deliver)).toEqual([
      'updated:wt-a:1',
      'updated:wt-b:1',
      'updated:wt-a:3',
      'updated:wt-b:2'
    ])
  })

  it('applies a quiet worktree at once again after the window', () => {
    const deliver = vi.fn()
    const coalescer = createWebSessionTabsStreamCoalescer(deliver)

    coalescer.offer(updated('wt-a', 1))
    vi.advanceTimersByTime(WEB_SESSION_TABS_UPDATE_FLUSH_MS)
    coalescer.offer(updated('wt-a', 2))
    expect(versionsOf(deliver)).toEqual(['updated:wt-a:1', 'updated:wt-a:2'])
  })

  it('keeps snapshots, inventories, removals and failures in stream order', () => {
    const deliver = vi.fn()
    const coalescer = createWebSessionTabsStreamCoalescer(deliver)

    coalescer.offer(updated('wt-a', 1))
    coalescer.offer(updated('wt-a', 2))
    coalescer.offer(frame({ type: 'snapshots', snapshots: [] }))
    coalescer.offer(updated('wt-a', 3))
    coalescer.offer(updated('wt-a', 4, { removed: true }))
    coalescer.offer(updated('wt-a', 5))
    coalescer.offer({
      id: 'x',
      ok: false,
      error: { code: 'boom', message: 'boom' }
    } as RuntimeRpcResponse<unknown>)
    coalescer.offer(frame({ type: 'end' }))
    expect(versionsOf(deliver)).toEqual([
      'updated:wt-a:1',
      'updated:wt-a:2',
      'snapshots::',
      'updated:wt-a:3',
      'updated:wt-a:4',
      'updated:wt-a:5',
      'error::',
      'end::'
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops pending frames once disposed', () => {
    const deliver = vi.fn()
    const coalescer = createWebSessionTabsStreamCoalescer(deliver)

    coalescer.offer(updated('wt-a', 1))
    coalescer.offer(updated('wt-a', 2))
    coalescer.dispose()
    coalescer.offer(updated('wt-a', 3))
    vi.advanceTimersByTime(WEB_SESSION_TABS_UPDATE_FLUSH_MS * 2)
    expect(versionsOf(deliver)).toEqual(['updated:wt-a:1'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
