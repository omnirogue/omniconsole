import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SessionChain } from '../../../shared/session-chain-types'

type Listener = (state: StoreState, previous: StoreState) => void
type StoreState = { agentStatusByPaneKey: Record<string, Partial<AgentStatusEntry>> }
const store = vi.hoisted(() => {
  const listeners = new Set<(state: unknown, previous: unknown) => void>()
  return { state: { agentStatusByPaneKey: {} } as { agentStatusByPaneKey: object }, listeners }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store.state,
    subscribe: (listener: Listener) => {
      store.listeners.add(listener as never)
      return () => store.listeners.delete(listener as never)
    }
  }
}))
const waits = vi.hoisted(() => ({ all: vi.fn() }))
vi.mock('@/lib/session-chain-waits', () => ({ waitForAllStops: waits.all }))
vi.mock('@/lib/session-chain-support', () => ({ sleepUnlessAborted: async () => undefined }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

import { SourceSessionBlockedError } from './next-session-launch'
import { paneBlock, paneStillWorking, waitForFinishedStops } from './session-chain-blocks'

const PANE = 'tab:11111111-1111-4111-8111-111111111111'

function setStatus(status: Partial<AgentStatusEntry> | undefined): void {
  const previous = store.state
  store.state = {
    agentStatusByPaneKey: status ? { [PANE]: { updatedAt: Date.now(), ...status } } : {}
  }
  for (const listener of store.listeners) {
    listener(store.state, previous)
  }
}

function planAccess() {
  let chain = { id: 'chn', state: 'waiting', blocked: null } as unknown as SessionChain
  const shown: (SessionChain['blocked'] | undefined)[] = []
  return {
    shown,
    current: () => chain,
    access: {
      getChain: () => chain,
      update: (patch: Partial<SessionChain>) => {
        chain = { ...chain, ...patch }
        if ('blocked' in patch) {
          shown.push(patch.blocked)
        }
        return chain
      }
    }
  }
}

beforeEach(() => {
  store.state = { agentStatusByPaneKey: {} }
  store.listeners.clear()
  waits.all.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('what counts as a pane asking the person', () => {
  it('is a question, an approval or an interrupted turn — never silence or a normal finish', () => {
    const at = (state: string, extra: object = {}) => ({
      [PANE]: { state, updatedAt: 1, ...extra } as AgentStatusEntry
    })
    expect(paneBlock([PANE], at('waiting'))).toEqual({ paneKey: PANE, reason: 'waiting' })
    expect(paneBlock([PANE], at('blocked'))).toEqual({ paneKey: PANE, reason: 'blocked' })
    expect(paneBlock([PANE], at('done', { interrupted: true }))).toEqual({
      paneKey: PANE,
      reason: 'interrupted'
    })
    expect(paneBlock([PANE], at('done'))).toBeNull()
    expect(paneBlock([PANE], at('working'))).toBeNull()
    expect(paneBlock([PANE], {})).toBeNull()
  })
  it('treats a silent or restored "working" as no evidence of work', () => {
    const now = 10_000_000
    const working = (extra: object) => ({
      [PANE]: { state: 'working', updatedAt: now, ...extra } as AgentStatusEntry
    })
    expect(paneStillWorking([PANE], working({}), now)).toBe(true)
    expect(paneStillWorking([PANE], working({ updatedAt: now - 31 * 60_000 }), now)).toBe(false)
    expect(paneStillWorking([PANE], working({ restoredUnconfirmed: true }), now)).toBe(false)
  })
})

describe('waiting for a plan step to really finish', () => {
  it('returns at once when the pane stopped and its agent reports a normal finish', async () => {
    setStatus({ state: 'done' })
    waits.all.mockResolvedValueOnce([{ handle: 'h', exited: false }])
    const plan = planAccess()
    await expect(
      waitForFinishedStops(plan.access, plan.current(), [PANE], new AbortController().signal)
    ).resolves.toEqual([{ handle: 'h', exited: false }])
    expect(plan.current().blocked).toBeNull()
    expect(store.listeners.size).toBe(0)
  })

  it('parks under Needs you while the agent asks, and carries on once it is answered', async () => {
    setStatus({ state: 'waiting' })
    waits.all.mockResolvedValue([{ handle: 'h', exited: false }])
    const plan = planAccess()
    const done = waitForFinishedStops(
      plan.access,
      plan.current(),
      [PANE],
      new AbortController().signal
    )
    await vi.waitFor(() =>
      expect(plan.current().blocked).toEqual({ paneKey: PANE, reason: 'waiting' })
    )
    let settled = false
    void done.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    setStatus({ state: 'working' })
    await vi.waitFor(() => expect(plan.current().blocked).toBeNull())
    expect(settled).toBe(false)
    setStatus({ state: 'done' })
    await done
    // Why: the stop is confirmed again after the answer, never taken from before it.
    expect(waits.all).toHaveBeenCalledTimes(2)
    expect(plan.current().blocked).toBeNull()
  })

  it('shows a question the agent reports while the wait is still running', async () => {
    let finish!: (value: unknown) => void
    waits.all.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const plan = planAccess()
    const done = waitForFinishedStops(
      plan.access,
      plan.current(),
      [PANE],
      new AbortController().signal
    )
    setStatus({ state: 'waiting' })
    expect(plan.current().blocked).toEqual({ paneKey: PANE, reason: 'waiting' })
    setStatus({ state: 'working' })
    expect(plan.current().blocked).toBeNull()
    setStatus({ state: 'done' })
    finish([{ handle: 'h', exited: false }])
    await done
    expect(plan.shown).toEqual([{ paneKey: PANE, reason: 'waiting' }, null])
  })

  it('parks on a prompt only the screen shows and looks again until it is gone', async () => {
    const blocked = new SourceSessionBlockedError('agent-approval-prompt')
    blocked.paneKey = PANE
    waits.all.mockRejectedValueOnce(blocked).mockResolvedValueOnce([{ handle: 'h', exited: false }])
    const plan = planAccess()
    await waitForFinishedStops(plan.access, plan.current(), [PANE], new AbortController().signal)
    expect(plan.shown[0]).toEqual({ paneKey: PANE, reason: 'agent-approval-prompt' })
    expect(plan.current().blocked).toBeNull()
    expect(waits.all).toHaveBeenCalledTimes(2)
  })

  it('never parks on old prompt text while the agent reports it is working', async () => {
    setStatus({ state: 'working' })
    const stale = new SourceSessionBlockedError('codex-trust-workspace')
    stale.paneKey = PANE
    waits.all.mockRejectedValueOnce(stale).mockResolvedValueOnce([{ handle: 'h', exited: false }])
    const plan = planAccess()
    const done = waitForFinishedStops(
      plan.access,
      plan.current(),
      [PANE],
      new AbortController().signal
    )
    await vi.waitFor(() => expect(waits.all).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(plan.current().blocked).toBeNull()
    expect(waits.all).toHaveBeenCalledTimes(1)
    setStatus({ state: 'done' })
    await done
    expect(plan.shown.filter(Boolean)).toEqual([])
    expect(waits.all).toHaveBeenCalledTimes(2)
  })

  it('fails on a real failure and leaves no mark behind', async () => {
    setStatus({ state: 'waiting' })
    waits.all.mockRejectedValueOnce(new Error('The source session exited with code 2'))
    const plan = planAccess()
    await expect(
      waitForFinishedStops(plan.access, plan.current(), [PANE], new AbortController().signal)
    ).rejects.toThrow('exited with code 2')
    expect(plan.current().blocked).toBeNull()
    expect(store.listeners.size).toBe(0)
  })

  it('stops waiting for an answer when the plan is cancelled', async () => {
    setStatus({ state: 'waiting' })
    waits.all.mockResolvedValue([{ handle: 'h', exited: false }])
    const controller = new AbortController()
    const plan = planAccess()
    const done = waitForFinishedStops(plan.access, plan.current(), [PANE], controller.signal)
    await vi.waitFor(() => expect(plan.current().blocked).not.toBeNull())
    controller.abort()
    await done
    expect(store.listeners.size).toBe(0)
  })
})
