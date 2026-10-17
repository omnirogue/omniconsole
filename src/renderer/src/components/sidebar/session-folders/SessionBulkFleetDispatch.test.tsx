// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SessionBulkFleetDispatch } from './SessionBulkFleetDispatch'

const mocks = vi.hoisted(() => ({
  controllers: new Map<
    string,
    { onPrepare: ReturnType<typeof vi.fn>; onDispatch: ReturnType<typeof vi.fn> }
  >(),
  tasks: new Map<string, { linked: { id: string; title: string }; deliverables: unknown }>(),
  activeKeys: new Set<string>(),
  scope: 'person-a'
}))
vi.mock('@/components/next-step/use-fleet-dispatch', () => ({
  useFleetDispatch: ({ session }: { session: SidebarSession }) =>
    mocks.controllers.get(session.sessionKey!)
}))
vi.mock('@/components/next-step/use-next-step-task', () => ({
  useNextStepTask: ({ session }: { session: SidebarSession }) =>
    mocks.tasks.get(session.sessionKey!) ?? {
      linked: { id: 'task_1', title: 'Task' },
      deliverables: null
    }
}))
vi.mock('@/components/next-step/add-next/dispatch-to-fleet', () => ({
  dispatchToFleet: async ({
    draft,
    target,
    fanoutAcknowledged,
    ports
  }: {
    draft: unknown
    target: { machineId: string | null }
    fanoutAcknowledged: boolean
    ports: {
      onPrepare: (draft: unknown, machine?: string, ack?: boolean) => Promise<unknown>
      onDispatch: (review: unknown) => Promise<void>
    }
  }) => {
    const review = await ports.onPrepare(draft, target.machineId ?? undefined, fanoutAcknowledged)
    await ports.onDispatch(review)
    return { warnings: [] }
  }
}))
// Why: the batch's sequencing is what this file pins; the door itself is pinned on
// RunsOnDispatch, so the shared body is reduced here to the one call it makes.
vi.mock('@/components/next-action/advanced/RunsOnDispatch', () => ({
  RunsOnDispatch: ({
    batch
  }: {
    batch: {
      count: number
      onSubmit: (draft: unknown, machine: string, ack: boolean) => Promise<void>
    }
  }) => (
    <button
      type="button"
      onClick={() =>
        void batch.onSubmit(
          {
            recipients: [],
            after: [],
            handoff: {
              task: { id: 'first-hydrated', title: 'First hydrated task' },
              deliverables: { kind: 'files', paths: ['first-only.txt'] },
              includeSummary: true
            }
          },
          'mac',
          batch.count > 1
        )
      }
    >
      Dispatch batch
    </button>
  )
}))
vi.mock('@/store/conversation-fleet-store', () => ({
  conversationFleetScope: () => mocks.scope,
  useConversationFleetRuns: () => [{}],
  useConversationFleetStore: { getState: () => ({ runs: [{}] }) }
}))
vi.mock('@/lib/conversation-fleet-sidebar', () => ({
  matchesConversationFleetSource: (_run: unknown, session: SidebarSession) =>
    mocks.activeKeys.has(session.sessionKey!)
}))
vi.mock('@/lib/conversation-fleet-progress', () => ({
  conversationFleetProgress: () => ({ phase: 'running' }),
  conversationFleetSettled: (phase: string) => phase === 'complete' || phase === 'cancelled'
}))

vi.mock('@/components/next-action/use-session-details-facts', () => ({
  useSessionDetailsFacts: () => ({ runsOn: 'This Mac' })
}))
vi.mock('@/lib/session-chain-registry', () => ({ useSessionChainForRow: () => null }))
vi.mock('@/components/next-action/advanced/SessionDetailsConnected', () => ({
  SessionDetailsConnected: ({ runsOnMenu }: { runsOnMenu: React.ReactNode }) => (
    <section>{runsOnMenu}</section>
  )
}))

const item = (id: string) => ({
  key: id,
  label: `Conversation ${id}`,
  session: {
    rowKey: id,
    sessionKey: id,
    worktreeId: 'repo:/x',
    kind: 'terminal',
    label: id,
    agent: 'codex',
    unavailable: false
  } as SidebarSession
})

/** Session details' "Runs on" popover must open before the bulk fleet plan mounts. */
function renderOpen(props: {
  items: readonly ReturnType<typeof item>[]
  onFinished: (outcomes: unknown) => void
}) {
  const view = render(<SessionBulkFleetDispatch {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Runs on' }))
  return view
}
afterEach(() => {
  cleanup()
  mocks.controllers.clear()
  mocks.tasks.clear()
  mocks.activeKeys.clear()
  mocks.scope = 'person-a'
})

describe('SessionBulkFleetDispatch', () => {
  it('replaces first-subject task and files with each target context', async () => {
    const prepareA = vi.fn().mockResolvedValue({ id: 'a' })
    const prepareB = vi.fn().mockResolvedValue({ id: 'b' })
    mocks.controllers.set('a', {
      onPrepare: prepareA,
      onDispatch: vi.fn().mockResolvedValue(undefined)
    })
    mocks.controllers.set('b', {
      onPrepare: prepareB,
      onDispatch: vi.fn().mockResolvedValue(undefined)
    })
    mocks.tasks.set('a', {
      linked: { id: 'task-a', title: 'Task A' },
      deliverables: { kind: 'files', paths: ['a.txt'] }
    })
    mocks.tasks.set('b', {
      linked: { id: 'task-b', title: 'Task B' },
      deliverables: { kind: 'files', paths: ['b.txt'] }
    })
    const done = vi.fn()
    renderOpen({ items: [item('a'), item('b')], onFinished: done })
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch batch' }))
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(prepareA.mock.calls[0][0].handoff).toMatchObject({
      task: { id: 'task-a' },
      deliverables: { paths: ['a.txt'] }
    })
    expect(prepareB.mock.calls[0][0].handoff).toMatchObject({
      task: { id: 'task-b' },
      deliverables: { paths: ['b.txt'] }
    })
  })

  it('reacts when controller readiness arrives asynchronously', async () => {
    const done = vi.fn()
    const props = { items: [item('a')], onFinished: done }
    const view = renderOpen(props)
    expect(screen.queryByRole('button', { name: 'Dispatch batch' })).toBeNull()
    mocks.controllers.set('a', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'a' }),
      onDispatch: vi.fn().mockResolvedValue(undefined)
    })
    view.rerender(<SessionBulkFleetDispatch {...props} />)
    expect(await screen.findByRole('button', { name: 'Dispatch batch' })).toBeTruthy()
  })

  it('allows one selected conversation without fanout consent and forwards false', async () => {
    const prepare = vi.fn().mockResolvedValue({ id: 'a' })
    mocks.controllers.set('a', {
      onPrepare: prepare,
      onDispatch: vi.fn().mockResolvedValue(undefined)
    })
    const done = vi.fn()
    renderOpen({ items: [item('a')], onFinished: done })
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch batch' }))
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(prepare.mock.calls[0][2]).toBe(false)
  })

  it('rechecks active runs before each later conversation', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.controllers.set('a', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'a' }),
      onDispatch: vi.fn().mockReturnValue(pending)
    })
    const secondDispatch = vi.fn().mockResolvedValue(undefined)
    mocks.controllers.set('b', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'b' }),
      onDispatch: secondDispatch
    })
    const done = vi.fn()
    renderOpen({ items: [item('a'), item('b')], onFinished: done })
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch batch' }))
    mocks.activeKeys.add('b')
    release()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(secondDispatch).not.toHaveBeenCalled()
  })

  it('stops and rejects an in-flight acknowledgement when the person changes', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.controllers.set('a', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'a' }),
      onDispatch: vi.fn().mockReturnValue(pending)
    })
    const secondDispatch = vi.fn().mockResolvedValue(undefined)
    mocks.controllers.set('b', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'b' }),
      onDispatch: secondDispatch
    })
    const done = vi.fn()
    renderOpen({ items: [item('a'), item('b')], onFinished: done })
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch batch' }))
    mocks.scope = 'person-b'
    release()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(secondDispatch).not.toHaveBeenCalled()
    expect(done.mock.calls[0][0]).toEqual([
      {
        key: 'a',
        label: 'Conversation a',
        ok: false,
        message:
          'Dispatch not confirmed: The signed-in person changed; this dispatch may have been accepted under the original account. Check its existing task and receipt before retrying.'
      },
      { key: 'b', label: 'Conversation b', ok: false, message: 'not sent' }
    ])
  })

  it('reports only acknowledged sends across a partial failure', async () => {
    mocks.controllers.set('a', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'a' }),
      onDispatch: vi.fn().mockResolvedValue(undefined)
    })
    mocks.controllers.set('b', {
      onPrepare: vi.fn().mockRejectedValue(new Error('offline')),
      onDispatch: vi.fn()
    })
    const done = vi.fn()
    renderOpen({ items: [item('a'), item('b')], onFinished: done })
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch batch' }))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(done.mock.calls[0][0]).toEqual([
      { key: 'a', label: 'Conversation a', ok: true },
      {
        key: 'b',
        label: 'Conversation b',
        ok: false,
        message:
          'Dispatch not confirmed: offline Check its existing task and receipt before retrying.'
      }
    ])
  })

  it('stops before sending remaining conversations after cancellation', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const firstDispatch = vi.fn().mockReturnValue(pending)
    const secondDispatch = vi.fn().mockResolvedValue(undefined)
    mocks.controllers.set('a', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'a' }),
      onDispatch: firstDispatch
    })
    mocks.controllers.set('b', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'b' }),
      onDispatch: secondDispatch
    })
    const done = vi.fn()
    renderOpen({ items: [item('a'), item('b')], onFinished: done })
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch batch' }))
    await waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    release()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(secondDispatch).not.toHaveBeenCalled()
    expect(done.mock.calls[0][0]).toEqual([
      { key: 'a', label: 'Conversation a', ok: true },
      { key: 'b', label: 'Conversation b', ok: false, message: 'not sent' }
    ])
  })

  it('ignores a second submit while the first batch is running', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch = vi.fn().mockReturnValue(pending)
    mocks.controllers.set('a', {
      onPrepare: vi.fn().mockResolvedValue({ id: 'a' }),
      onDispatch: dispatch
    })
    const done = vi.fn()
    renderOpen({ items: [item('a')], onFinished: done })
    const button = await screen.findByRole('button', { name: 'Dispatch batch' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    release()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  })
})
