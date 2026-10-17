// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import { EvolveRunView } from './EvolveRunView'
import { evolveRunFixture } from './evolve-run.fixtures'
import { EVOLVE_POLL_MS, useEvolveRuns } from './use-evolve-run'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), clipboard: vi.fn() }))
const state = { localWorkflowStatusByTabId: {} as Record<string, unknown> }

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

let current: EvolveRunRecord

function showCalls() {
  return mocks.rpc.mock.calls.filter(([, method]) => method === 'evolve.show').length
}

beforeEach(() => {
  vi.clearAllMocks()
  useEvolveRuns.setState({ runsById: {} })
  current = evolveRunFixture()
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) =>
    method === 'evolve.stop'
      ? { run: { ...current, state: 'stopped', stopRequestedAt: current.updatedAt } }
      : { run: current }
  )
  Object.assign(window, { api: { ui: { writeClipboardText: mocks.clipboard } } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('EvolveRunView', () => {
  it('shows the ledger run id and the exact status command with its host', async () => {
    render(<EvolveRunView tabId="evolve-tab" runId={current.id} />)
    expect(await screen.findByText('run_7f3a')).toBeInTheDocument()
    const command =
      'cd ~/Repos/jev-lab-evolve && .venv/bin/python -m jevlab evolve status run_7f3a --json'
    expect(screen.getByText(command)).toBeInTheDocument()
    expect(screen.getByText('run on mw0001')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy status command' }))
    expect(mocks.clipboard).toHaveBeenCalledWith(command)
    expect(screen.getByText('Evolving (3 of 8 mutations)')).toBeInTheDocument()
  })

  it('renders what the run was seeded from and its promotion records', async () => {
    render(<EvolveRunView tabId="evolve-tab" runId={current.id} />)
    const seeded = (await screen.findByText('run_earlier')).closest('tr') as HTMLElement
    expect(within(seeded).getByText('cand_old')).toBeInTheDocument()
    expect(within(seeded).getByText('0.7500')).toBeInTheDocument()
    expect(within(seeded).getByText('yes')).toBeInTheDocument()
    expect(within(seeded).getByText('0.7700')).toBeInTheDocument()
    const promotion = screen.getByText('cand_promo').closest('tr') as HTMLElement
    expect(within(promotion).getByText('eligible')).toBeInTheDocument()
    expect(within(promotion).getByText('no')).toBeInTheDocument()
    expect(screen.getByText('An eligible promotion record never deploys anything.')).toBeVisible()
  })

  it('stops a running worker only after an inline confirm', async () => {
    render(<EvolveRunView tabId="evolve-tab" runId={current.id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(mocks.rpc.mock.calls.some(([, method]) => method === 'evolve.stop')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'evolve.stop', { id: current.id })
    )
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('polls while the run is active and stops once it is done', async () => {
    vi.useFakeTimers()
    render(<EvolveRunView tabId="evolve-tab" runId={current.id} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(showCalls()).toBe(1)
    current = evolveRunFixture({
      state: 'done',
      ledger: { ...evolveRunFixture().ledger!, status: 'done' }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EVOLVE_POLL_MS)
    })
    expect(showCalls()).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EVOLVE_POLL_MS * 3)
    })
    expect(showCalls()).toBe(2)
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('checks an unverifiable run again on request', async () => {
    current = evolveRunFixture({ state: 'unverifiable' })
    render(<EvolveRunView tabId="evolve-tab" runId={current.id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'evolve.refresh', {
        id: current.id
      })
    )
    expect(screen.getByText('Lost contact with mw0001')).toBeInTheDocument()
  })
})
