// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_PREP_RPC,
  type SessionPrepBatchView,
  type SessionPrepItemView
} from '../../../../shared/session-prep-types'
import {
  consumeSessionPrepUndoBypass,
  resetSessionPrepComposerStateForTests
} from './session-prep-composer-state'
import { visibleSessionPrepBatches } from './use-session-prep-status'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string | number>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}))

import { SessionPrepStatus } from './SessionPrepStatus'

function item(state: SessionPrepItemView['state'], index: number): SessionPrepItemView {
  return { index, title: `item-${index}`, state, direct: false, repairs: 0 }
}

function batch(overrides: Partial<SessionPrepBatchView> = {}): SessionPrepBatchView {
  return {
    id: 'batch-1',
    createdAt: 10,
    state: 'planning',
    source: { worktreeId: 'wt', paneKey: 'pane-1', agent: 'claude' },
    request: 'create sessions for one and two',
    items: [item('planned', 0), item('planned', 1)],
    notes: [],
    ...overrides
  }
}

async function renderStatus(
  view: SessionPrepBatchView | SessionPrepBatchView[],
  draft = ''
): Promise<{ setDraft: ReturnType<typeof vi.fn> }> {
  const setDraft = vi.fn()
  mocks.callRuntimeRpc.mockImplementation((_target, method: string) => {
    if (method === SESSION_PREP_RPC.listForSource) {
      return Promise.resolve({ batches: Array.isArray(view) ? view : [view] })
    }
    return Promise.resolve({})
  })
  render(<SessionPrepStatus paneKey="pane-1" draft={draft} setDraft={setDraft} />)
  await waitFor(() => {
    expect(mocks.callRuntimeRpc).toHaveBeenCalled()
  })
  return { setDraft }
}

describe('visibleSessionPrepBatches', () => {
  it('hides cancelled batches, keeps at most two, and hides done after 15s', () => {
    const terminalAt = new Map<string, number>([
      ['done-old', 0],
      ['done-new', 14_000]
    ])
    const views = [
      batch({ id: 'cancelled', state: 'cancelled', createdAt: 50 }),
      batch({ id: 'done-old', state: 'done', createdAt: 40 }),
      batch({ id: 'done-new', state: 'done', createdAt: 30 }),
      batch({ id: 'run', state: 'running', createdAt: 20 }),
      batch({ id: 'plan', state: 'planning', createdAt: 10 })
    ]
    const visible = visibleSessionPrepBatches(views, terminalAt, 15_000)
    expect(visible.map((entry) => entry.id)).toEqual(['done-new', 'run'])
  })
})

describe('SessionPrepStatus', () => {
  beforeEach(() => {
    resetSessionPrepComposerStateForTests()
    mocks.callRuntimeRpc.mockReset()
  })

  afterEach(() => {
    cleanup()
    resetSessionPrepComposerStateForTests()
  })

  it('renders planning', async () => {
    await renderStatus(batch({ state: 'planning' }))
    expect(screen.getByText('Planning sessions…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders running with Undo only before anything launches', async () => {
    await renderStatus(
      batch({
        state: 'running',
        items: [item('preparing', 0), item('planned', 1)]
      })
    )
    expect(screen.getByText('Preparing 2 sessions · 0 launched')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('hides Undo once a session has launched', async () => {
    await renderStatus(
      batch({
        state: 'running',
        items: [item('launched', 0), item('preparing', 1)]
      })
    )
    expect(screen.getByText('Preparing 2 sessions · 1 launched')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('renders awaiting-confirm with Launch all and Cancel', async () => {
    await renderStatus(batch({ state: 'awaiting-confirm' }))
    expect(screen.getByText('2 sessions planned')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Launch all' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('renders done and done-with-failures', async () => {
    await renderStatus(
      batch({
        state: 'done',
        items: [item('launched', 0), item('launched', 1)]
      })
    )
    expect(screen.getByText('2 sessions launched')).toBeTruthy()
    cleanup()
    mocks.callRuntimeRpc.mockReset()
    await renderStatus(
      batch({
        id: 'batch-2',
        state: 'done',
        items: [item('launched', 0), item('failed', 1)]
      })
    )
    expect(screen.getByText('1 sessions launched · 1 not launched')).toBeTruthy()
  })

  it('counts skipped asks and lists every reason on hover', async () => {
    await renderStatus(
      batch({
        state: 'done',
        items: [
          item('launched', 0),
          { ...item('launched', 1), note: 'Launched with your own words' }
        ],
        notes: ['Dropped "Billing": not found in your words']
      })
    )
    expect(screen.getByText('· 1 skipped')).toBeTruthy()
    const row = document.querySelector('[data-session-prep-status="done"]')
    expect(row?.getAttribute('title')).toBe(
      'Dropped "Billing": not found in your words\nLaunched with your own words'
    )
  })

  it("lists each session's agent, model, effort, template and folder on hover", async () => {
    await renderStatus(
      batch({
        state: 'running',
        items: [
          {
            ...item('launched', 0),
            title: 'Pricing prototype',
            agent: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
            folder: 'Saved Sessions / OmniRogue / Prototypes'
          },
          {
            ...item('preparing', 1),
            title: 'Docs',
            agent: 'claude',
            effort: 'low',
            agentTemplate: 'Reviewer'
          }
        ]
      })
    )
    const row = document.querySelector('[data-session-prep-status="running"]')
    expect(row?.getAttribute('title')).toBe(
      'Pricing prototype — codex gpt-5.6-sol high effort → Saved Sessions / OmniRogue / Prototypes\nDocs — claude low effort · Reviewer template'
    )
  })

  it('keeps the failure reason in the tooltip without a skipped count', async () => {
    await renderStatus(batch({ state: 'failed', items: [], notes: ['Could not resume: gone'] }))
    expect(screen.queryByText(/skipped/)).toBeNull()
    const row = document.querySelector('[data-session-prep-status="failed"]')
    expect(row?.getAttribute('title')).toBe('Could not resume: gone')
  })

  it('renders failed and hides cancelled', async () => {
    await renderStatus(batch({ state: 'failed' }))
    expect(screen.getByText('Could not prepare sessions')).toBeTruthy()
    cleanup()
    mocks.callRuntimeRpc.mockReset()
    await renderStatus(batch({ state: 'cancelled' }))
    expect(screen.queryByText('Planning sessions…')).toBeNull()
    expect(screen.queryByText('Could not prepare sessions')).toBeNull()
  })

  it('Undo cancels, restores an empty draft, and arms the bypass', async () => {
    const { setDraft } = await renderStatus(
      batch({
        state: 'running',
        items: [item('preparing', 0), item('planned', 1)]
      })
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, SESSION_PREP_RPC.cancel, {
      batchId: 'batch-1'
    })
    expect(setDraft).toHaveBeenCalledWith('create sessions for one and two')
    expect(consumeSessionPrepUndoBypass('pane-1', 'create sessions for one and two')).toBe(true)
  })

  it('Launch all confirms and Cancel cancels without restoring the draft', async () => {
    const { setDraft } = await renderStatus(batch({ state: 'awaiting-confirm' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch all' }))
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, SESSION_PREP_RPC.confirm, {
      batchId: 'batch-1'
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, SESSION_PREP_RPC.cancel, {
      batchId: 'batch-1'
    })
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('keeps the last snapshot when listing fails', async () => {
    let calls = 0
    mocks.callRuntimeRpc.mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({ batches: [batch({ state: 'planning' })] })
      }
      return Promise.reject(new Error('offline'))
    })
    render(<SessionPrepStatus paneKey="pane-1" draft="" setDraft={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('Planning sessions…')).toBeTruthy()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('Planning sessions…')).toBeTruthy()
  })
})
