// @vitest-environment happy-dom
/**
 * The whole visible surface of Prompt Queue: one item at the top of ＋, a box that
 * queues on Enter, two chips, and a strip that shows what is waiting.
 *
 * The acceptance the frozen model asks for is asserted here too: not one of these
 * clicks calls a session-chain or outcome method — queuing the next prompt is
 * ordinary conversation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROMPT_QUEUE_RPC,
  type PromptQueue,
  type PromptQueueEntry,
  type PromptQueueWaitReason
} from '../../../../shared/prompt-queue-types'
import { AddNextPanels } from '../next-step/add-next/AddNextPanels'
import { NewPromptPanel } from './NewPromptPanel'
import { PromptQueueStrip } from './PromptQueueStrip'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  scope: 0,
  queue: { source: { worktreeId: 'wt', paneKey: 'pane', kind: 'pty' }, entries: [] } as PromptQueue,
  waitReason: undefined as PromptQueueWaitReason | undefined
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))
vi.mock('@/lib/session-data-scope', () => ({
  useSessionDataScope: () => String(mocks.scope),
  sessionDataScopeKey: () => String(mocks.scope),
  isSessionDataScopeCurrent: (scope: string) => scope === String(mocks.scope)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))
vi.mock('../next-step/NextStepAgentCard', () => ({ NextStepAgentCard: () => null }))
vi.mock('../next-step/next-step-placement', () => ({ findNextStepWorkspaceId: () => null }))
vi.mock('../next-step/use-next-step-task', () => ({ useNextStepTask: () => ({ linked: null }) }))
vi.mock('../next-step/use-next-step-recipients', () => ({
  useNextStepRecipients: () => ({
    agents: { phase: 'ready', value: [{ id: 'claude', label: 'Claude' }] },
    people: { phase: 'ready', value: [] },
    reload: vi.fn(),
    refreshAgents: vi.fn(),
    agentDetails: new Map(),
    hiddenAgents: [],
    peopleSource: 'directory',
    peopleIncomplete: false
  })
}))
const state = {
  sshTargetLabels: new Map<string, string>(),
  sshConnectionStates: new Map<string, { status: string }>(),
  getKnownWorktreeById: () => undefined,
  repos: [],
  settings: {}
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (value: unknown) => unknown) => select(state), {
    getState: () => state
  })
}))

const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const session = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'wt',
  hostId: 'local' as const,
  tabId: 'tab-1',
  paneKey: 'tab-1:leaf-1',
  kind: 'terminal' as const,
  label: 'Improve the previous result',
  workspaceLabel: 'omni-ide',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

const entry = (over: Partial<PromptQueueEntry> = {}): PromptQueueEntry => ({
  id: 'e1',
  text: 'Have you done your best job?',
  createdAt: 1,
  state: 'queued',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope += 1
  mocks.queue = { source, entries: [] }
  mocks.waitReason = undefined
  mocks.rpc.mockImplementation(async (_target: unknown, method: string, params: unknown) => {
    if (method === PROMPT_QUEUE_RPC.enqueue) {
      const { id, text } = params as { id: string; text: string }
      mocks.queue = { source, entries: [...mocks.queue.entries, entry({ id, text })] }
    }
    return method === PROMPT_QUEUE_RPC.list && mocks.waitReason
      ? { queue: mocks.queue, waitReason: mocks.waitReason }
      : { queue: mocks.queue }
  })
})
afterEach(cleanup)

const calledMethods = (): string[] =>
  mocks.rpc.mock.calls.map((call) => String((call as unknown[])[1]))

describe('the ＋ menu', () => {
  it('offers New prompt first, before who gets this next', async () => {
    render(
      <AddNextPanels
        subject={{ kind: 'session', session } as never}
        dispatch={false}
        onSent={vi.fn()}
      />
    )
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items[0]).toContain('New prompt')
    expect(items).toContain('Research')
    expect(items).not.toContain('🤖 Agent')
  })

  it('opens the prompt box, and nothing it does touches a plan', async () => {
    render(
      <AddNextPanels
        subject={{ kind: 'session', session } as never}
        dispatch={false}
        onSent={vi.fn()}
      />
    )
    act(() => screen.getByRole('menuitem', { name: /sent when it finishes/ }).click())
    expect(screen.getByRole('textbox', { name: 'New prompt' })).toBeTruthy()
    expect(calledMethods().every((method) => method.startsWith('promptQueue.'))).toBe(true)
  })
})

describe('the prompt box', () => {
  it('queues on Enter and closes, sending the person’s words unchanged', async () => {
    const onClose = vi.fn()
    render(<NewPromptPanel source={source} onClose={onClose} />)
    const box = screen.getByRole('textbox', { name: 'New prompt' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Now plan it' } })
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
      await Promise.resolve()
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      PROMPT_QUEUE_RPC.enqueue,
      expect.objectContaining({ source, text: 'Now plan it' })
    )
  })

  it('queues either chip with exactly its own text', async () => {
    render(<NewPromptPanel source={source} onClose={vi.fn()} />)
    await act(async () => {
      screen.getByRole('button', { name: 'Have you done your best job?' }).click()
      await Promise.resolve()
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Continue' }).click()
      await Promise.resolve()
    })
    const texts = mocks.rpc.mock.calls
      .filter((call) => call[1] === PROMPT_QUEUE_RPC.enqueue)
      .map((call) => (call[2] as { text: string }).text)
    expect(texts).toEqual(['Have you done your best job?', 'Continue'])
  })

  it('keeps the text when the host refuses, so nothing typed is lost', async () => {
    mocks.rpc.mockRejectedValue(new Error('This conversation is no longer open.'))
    const onClose = vi.fn()
    render(<NewPromptPanel source={source} onClose={onClose} />)
    await act(async () => {
      screen.getByRole('button', { name: 'Continue' }).click()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByText('This conversation is no longer open.')).toBeTruthy()
    )
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the strip under the work header', () => {
  it('is absent when nothing is queued', async () => {
    const { container } = render(<PromptQueueStrip source={source} />)
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled())
    expect(container.querySelector('[data-prompt-queue-strip]')).toBeNull()
  })

  it('counts what is waiting and shows each prompt in order', async () => {
    mocks.queue = {
      source,
      entries: [
        entry({ id: 'e1', text: 'Plan' }),
        entry({ id: 'e2', text: 'Have you done your best job?' })
      ]
    }
    render(<PromptQueueStrip source={source} />)
    await waitFor(() => expect(screen.getByText('Queued 2')).toBeTruthy())
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('Have you done your best job?')).toBeTruthy()
  })

  it('says Sending… while one is going out', async () => {
    mocks.queue = { source, entries: [entry({ state: 'sending' })] }
    render(<PromptQueueStrip source={source} />)
    await waitFor(() => expect(screen.getByText('Sending…')).toBeTruthy())
  })

  it('names the prompt that could not be delivered, with the reason on hover', async () => {
    mocks.queue = {
      source,
      entries: [entry({ state: 'failed', reason: 'This terminal conversation is no longer open.' })]
    }
    render(<PromptQueueStrip source={source} />)
    const failed = await screen.findByText("Failed: 'Have you done your best job?'")
    expect(failed.getAttribute('title')).toBe('This terminal conversation is no longer open.')
    // Not the person's own paused prompt: it can be dismissed, not queued again.
    expect(screen.queryByRole('button', { name: 'Queue again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  describe('paused behind a failed prompt', () => {
    beforeEach(() => {
      mocks.queue = {
        source,
        entries: [
          entry({
            id: 'e1',
            text: 'Research the code',
            state: 'failed',
            reason: 'terminal_not_writable',
            holdsQueue: true,
            unsent: true
          }),
          entry({ id: 'e2', text: 'Now plan it' })
        ]
      }
      mocks.waitReason = { kind: 'paused-after-failure', entryId: 'e1' }
    })

    it('says which prompt failed, with the reason on hover', async () => {
      render(<PromptQueueStrip source={source} />)
      const paused = await screen.findByText("Paused: 'Research the code' failed")
      expect(paused.getAttribute('title')).toBe('The terminal no longer accepts input.')
      expect(screen.getByText('Queued 1')).toBeTruthy()
    })

    it('queues it again or dismisses it through the queue methods', async () => {
      render(<PromptQueueStrip source={source} />)
      await screen.findByText("Paused: 'Research the code' failed")
      await act(async () => {
        screen.getByRole('button', { name: 'Queue again' }).click()
        await Promise.resolve()
      })
      await act(async () => {
        screen.getByRole('button', { name: 'Dismiss' }).click()
        await Promise.resolve()
      })
      expect(mocks.rpc).toHaveBeenCalledWith(
        { kind: 'local' },
        PROMPT_QUEUE_RPC.requeue,
        expect.objectContaining({ entryId: 'e1' })
      )
      expect(mocks.rpc).toHaveBeenCalledWith(
        { kind: 'local' },
        PROMPT_QUEUE_RPC.remove,
        expect.objectContaining({ entryId: 'e1' })
      )
    })

    it('reads as a plain failure from a host that sends no wait reason', async () => {
      mocks.waitReason = undefined
      render(<PromptQueueStrip source={source} />)
      expect(await screen.findByText("Failed: 'Research the code'")).toBeTruthy()
    })
  })

  it('reorders and removes through the queue methods only', async () => {
    mocks.queue = {
      source,
      entries: [entry({ id: 'e1', text: 'Plan' }), entry({ id: 'e2', text: 'Build' })]
    }
    render(<PromptQueueStrip source={source} />)
    await waitFor(() => expect(screen.getByText('Plan')).toBeTruthy())
    await act(async () => {
      screen.getAllByRole('button', { name: 'Move later' })[0]!.click()
      await Promise.resolve()
    })
    await act(async () => {
      screen.getAllByRole('button', { name: 'Remove this queued prompt' })[0]!.click()
      await Promise.resolve()
    })
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      PROMPT_QUEUE_RPC.reorder,
      expect.objectContaining({ entryId: 'e1', direction: 'down' })
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      PROMPT_QUEUE_RPC.remove,
      expect.objectContaining({ entryId: 'e1' })
    )
    expect(new Set(calledMethods())).toEqual(
      new Set([PROMPT_QUEUE_RPC.list, PROMPT_QUEUE_RPC.reorder, PROMPT_QUEUE_RPC.remove])
    )
  })
})
