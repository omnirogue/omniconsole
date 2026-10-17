// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaneFocusContext } from './pane-focus-context'
import { useSessionDecisionQueue } from './needs-you/use-session-decisions'
import { useReviewWaits } from './work/use-review-waits'
import { enqueuePromptOnce, usePromptQueue } from './prompt-queue/use-prompt-queue'
import {
  emptyPromptQueue,
  PROMPT_QUEUE_RPC,
  type PromptQueue
} from '../../../shared/prompt-queue-types'
import { SESSION_DECISIONS_RPC, type SessionDecision } from '../../../shared/session-decisions'
import type { ConversationSource } from '../../../shared/conversation-source'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), scope: 0 }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/session-data-scope', () => ({
  useSessionDataScope: () => String(mocks.scope),
  sessionDataScopeKey: () => String(mocks.scope),
  isSessionDataScopeCurrent: (key: string) => key === String(mocks.scope)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
const VISIBLE = { visible: true, focused: true }
const HIDDEN = { visible: false, focused: true }
const source: ConversationSource = { worktreeId: 'folder:work', paneKey: 'tab:leaf', kind: 'pty' }
const decision = (key: string, score = 0.5): SessionDecision => ({
  key,
  paneKey: key,
  worktreeId: 'folder:work',
  agent: 'claude',
  askedAt: 1,
  toolUseId: key,
  toolName: 'AskUserQuestion',
  interactivePrompt: '{}',
  context: null,
  providerSession: null,
  endedAt: null,
  scores: { impact: score, risk: 0, effort: 1, model: 'jev', at: 1 },
  updatedAt: 1,
  title: null,
  questions: [],
  scoreUnavailable: null
})
const tick = async (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
beforeEach(() => {
  vi.useFakeTimers()
  mocks.scope += 1
  mocks.rpc.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('shares each native interval across two readers without sharing timers across different feeds', async () => {
  mocks.rpc.mockImplementation(async (_target, method) =>
    method === SESSION_DECISIONS_RPC.list
      ? { decisions: [] }
      : method === PROMPT_QUEUE_RPC.list
        ? { queue: emptyPromptQueue(source) }
        : { status: 'ok', inbox: 'ok', items: [] }
  )
  const first = renderHook(() => {
    useSessionDecisionQueue()
    useReviewWaits()
    usePromptQueue(source)
  })
  const second = renderHook(() => {
    useSessionDecisionQueue()
    useReviewWaits()
    usePromptQueue({ ...source })
  })
  await tick()
  const calls = (method: string) => mocks.rpc.mock.calls.filter((call) => call[1] === method).length
  expect(calls(SESSION_DECISIONS_RPC.list)).toBe(1)
  expect(calls(PROMPT_QUEUE_RPC.list)).toBe(1)
  expect(calls('artifacts.reviewWaits')).toBe(1)
  first.unmount()
  await tick(60_000)
  expect(calls(SESSION_DECISIONS_RPC.list)).toBe(21)
  expect(calls(PROMPT_QUEUE_RPC.list)).toBe(31)
  expect(calls('artifacts.reviewWaits')).toBe(2)
  second.unmount()
  await tick(60_000)
  expect(calls('artifacts.reviewWaits')).toBe(2)
})

it('shares skip, pin and answered state immediately and keeps the pin across reordered reads', async () => {
  mocks.rpc.mockResolvedValue({ decisions: [decision('a', 0.9), decision('b', 0.5)] })
  const first = renderHook(() => useSessionDecisionQueue())
  const second = renderHook(() => useSessionDecisionQueue())
  await tick()
  expect(first.result.current.current?.key).toBe('a')
  act(() => first.result.current.skip('a'))
  expect(second.result.current.current?.key).toBe('b')
  mocks.rpc.mockResolvedValue({
    decisions: [decision('a', 0.9), decision('b', 0.5), decision('c', 1)]
  })
  await tick(3000)
  expect(first.result.current.current?.key).toBe('b')
  act(() => second.result.current.answered('b'))
  expect(first.result.current.total).toBe(2)
  expect(first.result.current.current?.key).toBe('c')
  await tick()
  expect(second.result.current.total).toBe(2)
})

it('pauses all three feeds in a hidden pane and resumes on restore', async () => {
  mocks.rpc.mockImplementation(async (_target, method) =>
    method === SESSION_DECISIONS_RPC.list
      ? { decisions: [] }
      : method === PROMPT_QUEUE_RPC.list
        ? { queue: emptyPromptQueue(source) }
        : { status: 'ok', inbox: 'ok', items: [] }
  )
  let focus = HIDDEN
  const { rerender } = renderHook(
    () => {
      useSessionDecisionQueue()
      useReviewWaits()
      usePromptQueue(source)
    },
    {
      wrapper: ({ children }) => (
        <PaneFocusContext.Provider value={focus}>{children}</PaneFocusContext.Provider>
      )
    }
  )
  await tick(60_000)
  expect(mocks.rpc).not.toHaveBeenCalled()
  focus = VISIBLE
  rerender()
  await tick()
  expect(mocks.rpc).toHaveBeenCalledTimes(3)
  focus = HIDDEN
  rerender()
  await tick(60_000)
  expect(mocks.rpc).toHaveBeenCalledTimes(3)
})

it('publishes prompt writes to every reader, including one-shot enqueue, and preserves errors', async () => {
  let queue = emptyPromptQueue(source)
  mocks.rpc.mockImplementation(async (_target, method, params) => {
    if (method === PROMPT_QUEUE_RPC.enqueue) {
      queue = {
        source,
        entries: [
          ...queue.entries,
          { id: params.id, text: params.text, state: 'queued', createdAt: 1 }
        ]
      }
    }
    return { queue }
  })
  const first = renderHook(() => usePromptQueue(source))
  const second = renderHook(() => usePromptQueue(source))
  await tick()
  await act(async () => first.result.current.enqueue(' next '))
  expect(second.result.current.queue.entries[0]?.text).toBe('next')
  await act(async () => {
    await enqueuePromptOnce(source, 'then')
  })
  expect(first.result.current.queue.entries).toHaveLength(2)
  mocks.rpc.mockRejectedValueOnce(new Error('offline'))
  await tick(2000)
  expect(second.result.current).toMatchObject({ status: 'stale', error: 'offline' })
  expect(second.result.current.queue.entries).toHaveLength(2)
})

it('isolates queues and rejects predecessor responses after an account change', async () => {
  let finish!: (value: { queue: PromptQueue }) => void
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(({ addressed }) => usePromptQueue(addressed), {
    initialProps: { addressed: source }
  })
  await tick()
  mocks.scope += 1
  const nextSource = { ...source, paneKey: 'other:leaf' }
  mocks.rpc.mockResolvedValue({ queue: emptyPromptQueue(nextSource) })
  hook.rerender({ addressed: nextSource })
  await tick()
  await act(async () => {
    finish({
      queue: { source, entries: [{ id: 'old', text: 'private', createdAt: 1, state: 'queued' }] }
    })
  })
  expect(hook.result.current.queue).toEqual(emptyPromptQueue(nextSource))
  expect(hook.result.current.error).toBeNull()
})
