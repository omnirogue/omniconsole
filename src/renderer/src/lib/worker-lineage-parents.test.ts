import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  readRememberedWorkerParents,
  resolveUserRetainedWorkerLeaves,
  resolveWorkerDispatchIds,
  resolveWorkerParentLeaves,
  saveRememberedWorkerParents,
  WORKER_TAB_LEAD_MS
} from './worker-lineage-parents'

const leaf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DISPATCHED = 1_000_000_000

afterEach(() => vi.unstubAllGlobals())

function layout(ptyIdsByLeafId: Record<string, string>): TerminalLayoutSnapshot {
  return { root: null, activeLeafId: null, expandedLeafId: null, ptyIdsByLeafId }
}

describe('resolveWorkerParentLeaves', () => {
  it('finds a paired runtime worker by its terminal handle among the mirrored panes', () => {
    const parents = resolveWorkerParentLeaves({
      links: [
        {
          parentPaneKey: `tab-1:${leaf(1)}`,
          child: { kind: 'remote-terminal', environmentId: 'env-1', terminal: 'term_remote' },
          dispatchedAt: DISPATCHED
        }
      ],
      terminalLayoutsByTabId: {
        'mirror-tab': layout({ [leaf(2)]: toRemoteRuntimePtyId('term_remote', 'env-1') }),
        'other-env': layout({ [leaf(3)]: toRemoteRuntimePtyId('term_remote', 'env-2') })
      },
      tabsByWorktree: {}
    })
    expect([...parents]).toEqual([[leaf(2), leaf(1)]])
  })

  it('leaves a session the person had open long before the dispatch as their own', () => {
    const resolve = (createdAt: number) =>
      resolveWorkerParentLeaves({
        links: [
          {
            parentPaneKey: `tab-1:${leaf(1)}`,
            child: { kind: 'pane', paneKey: `tab-2:${leaf(2)}` },
            dispatchedAt: DISPATCHED
          }
        ],
        terminalLayoutsByTabId: {},
        tabsByWorktree: { w1: [{ id: 'tab-2', createdAt }] }
      })
    expect(resolve(DISPATCHED - WORKER_TAB_LEAD_MS - 1).size).toBe(0)
    expect([...resolve(DISPATCHED - 60_000)]).toEqual([[leaf(2), leaf(1)]])
  })

  it('restores the durable pane parent after a renderer restart', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    })

    saveRememberedWorkerParents(new Map([[leaf(2), leaf(1)]]))

    expect([...readRememberedWorkerParents()]).toEqual([[leaf(2), leaf(1)]])
  })

  it('exposes only fresh dispatch identities and clears remembered grouping after user retention', () => {
    const args = {
      links: [
        {
          parentPaneKey: `tab-1:${leaf(1)}`,
          child: { kind: 'pane' as const, paneKey: `tab-2:${leaf(2)}` },
          dispatchedAt: DISPATCHED,
          dispatchId: 'dispatch-1',
          processIncarnation: 'proc-1',
          retainedByUser: true
        }
      ],
      terminalLayoutsByTabId: {},
      tabsByWorktree: {}
    }
    expect([...resolveWorkerDispatchIds(args)]).toEqual([])
    expect([...resolveWorkerParentLeaves(args)]).toEqual([])
    expect([...resolveUserRetainedWorkerLeaves(args)]).toEqual([leaf(2)])
  })

  it('does not confer SUB or a dispatch action from an invalid parent identity', () => {
    const args = {
      links: [
        {
          parentPaneKey: 'foreign-runtime-session',
          child: { kind: 'pane' as const, paneKey: `tab-2:${leaf(2)}` },
          dispatchedAt: DISPATCHED,
          dispatchId: 'dispatch-1'
        }
      ],
      terminalLayoutsByTabId: {},
      tabsByWorktree: {}
    }
    expect([...resolveWorkerParentLeaves(args)]).toEqual([])
    expect([...resolveWorkerDispatchIds(args)]).toEqual([])
  })

  it('returns the exact current worker identity needed by Keep', () => {
    const args = {
      links: [
        {
          parentPaneKey: `tab-1:${leaf(1)}`,
          child: { kind: 'pane' as const, paneKey: `tab-2:${leaf(2)}` },
          dispatchedAt: DISPATCHED,
          dispatchId: 'dispatch-current',
          processIncarnation: 'proc-current'
        }
      ],
      terminalLayoutsByTabId: {},
      tabsByWorktree: {}
    }
    expect([...resolveWorkerDispatchIds(args)]).toEqual([
      [leaf(2), { dispatchId: 'dispatch-current', processIncarnation: 'proc-current' }]
    ])
  })
})
