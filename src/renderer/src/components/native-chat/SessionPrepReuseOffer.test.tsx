// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_PREP_RPC, type SessionPrepBatchView } from '../../../../shared/session-prep-types'
import { resetSessionPrepComposerStateForTests } from './session-prep-composer-state'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string | number>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}))

import { SessionPrepStatus } from './SessionPrepStatus'

const OFFERED: SessionPrepBatchView = {
  id: 'batch-1',
  createdAt: 10,
  state: 'running',
  source: { worktreeId: 'wt', paneKey: 'pane-1', agent: 'claude' },
  request: 'add retries to the parser',
  items: [
    {
      index: 0,
      title: 'Parser retries',
      state: 'awaiting-reuse',
      direct: false,
      repairs: 0,
      reuse: { kind: 'assign', title: 'Parser work', why: 'idle, same folder' }
    }
  ],
  notes: []
}

async function renderOffer(view: SessionPrepBatchView = OFFERED): Promise<void> {
  mocks.callRuntimeRpc.mockImplementation((_target, method: string) =>
    Promise.resolve(method === SESSION_PREP_RPC.listForSource ? { batches: [view] } : {})
  )
  render(<SessionPrepStatus paneKey="pane-1" draft="" setDraft={vi.fn()} />)
  await waitFor(() => {
    expect(screen.getByText('Parser retries')).toBeTruthy()
  })
}

function decideCalls(): unknown[] {
  return mocks.callRuntimeRpc.mock.calls
    .filter(([, method]) => method === SESSION_PREP_RPC.decideReuse)
    .map(([, , params]) => params)
}

describe('SessionPrepReuseOffer', () => {
  beforeEach(() => {
    resetSessionPrepComposerStateForTests()
    mocks.callRuntimeRpc.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('pre-selects giving the task to the offered session, and Confirm sends that choice', async () => {
    await renderOffer()
    const give = screen.getByRole('radio', {
      name: 'Give to “Parser work” (idle, same folder) instead of launching'
    })
    expect(give.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Launch new' }).getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(decideCalls()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(decideCalls()).toEqual([{ batchId: 'batch-1', index: 0, choice: 'assign' }])
  })

  it('switches back to Launch new in one click', async () => {
    await renderOffer()
    fireEvent.click(screen.getByRole('radio', { name: 'Launch new' }))
    expect(screen.getByRole('radio', { name: 'Launch new' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(decideCalls()).toEqual([{ batchId: 'batch-1', index: 0, choice: 'launch' }])
  })

  it('shows why giving it to that session did not work', async () => {
    await renderOffer({
      ...OFFERED,
      items: [
        {
          ...OFFERED.items[0]!,
          reuse: { ...OFFERED.items[0]!.reuse!, failed: '“Parser work” is no longer free' }
        }
      ]
    })
    expect(
      screen.getByText('Could not give it to that session: “Parser work” is no longer free')
    ).toBeTruthy()
  })

  it('for a duplicate, pre-selects "Already being done" and offers only Launch anyway', async () => {
    await renderOffer({
      ...OFFERED,
      items: [
        {
          ...OFFERED.items[0]!,
          reuse: { kind: 'duplicate', title: 'Parser work', why: 'busy, same folder' }
        }
      ]
    })
    const keep = screen.getByRole('radio', { name: 'Already being done by “Parser work”' })
    const launch = screen.getByRole('radio', { name: 'Launch anyway' })
    expect(keep.getAttribute('aria-checked')).toBe('true')
    expect(launch.getAttribute('aria-checked')).toBe('false')
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(decideCalls()).toEqual([{ batchId: 'batch-1', index: 0, choice: 'skip' }])
  })

  it('names a busy editor of the same files and launches only on Launch anyway', async () => {
    await renderOffer({
      ...OFFERED,
      items: [
        {
          ...OFFERED.items[0]!,
          reuse: { kind: 'conflict-busy', title: 'Auth fix', why: 'busy, editing the same files' }
        }
      ]
    })
    expect(
      screen
        .getByRole('radio', {
          name: '“Auth fix” is already editing these files (busy, editing the same files)'
        })
        .getAttribute('aria-checked')
    ).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Launch anyway' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(decideCalls()).toEqual([{ batchId: 'batch-1', index: 0, choice: 'launch' }])
  })

  it('counts tasks given to existing sessions once the batch is done', async () => {
    mocks.callRuntimeRpc.mockImplementation((_target, method: string) =>
      Promise.resolve(
        method === SESSION_PREP_RPC.listForSource
          ? {
              batches: [
                {
                  ...OFFERED,
                  state: 'done',
                  items: [{ ...OFFERED.items[0]!, state: 'assigned' }]
                }
              ]
            }
          : {}
      )
    )
    render(<SessionPrepStatus paneKey="pane-1" draft="" setDraft={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByText('· 1 given to existing sessions')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })
})
