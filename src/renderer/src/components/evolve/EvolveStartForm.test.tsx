// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createEvolveDraft, type EvolveDraft } from '../../../../shared/evolve-workflow-draft'
import { EvolveStartForm } from './EvolveStartForm'
import { evolveRunFixture } from './evolve-run.fixtures'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), update: vi.fn(), title: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/local-workflow-conversation', () => ({
  updateLocalWorkflowConversation: mocks.update,
  titleLocalWorkflowConversation: mocks.title
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

const tab = (draft?: Partial<EvolveDraft>): TerminalTab =>
  ({
    id: 'evolve-tab',
    worktreeId: 'repo::/workspace',
    localWorkflow: {
      preset: 'evolve',
      prompt: '',
      ...(draft ? { evolveDraft: { ...createEvolveDraft(), ...draft } } : {})
    }
  }) as TerminalTab

function startCalls() {
  return mocks.rpc.mock.calls.filter(([, method]) => method === 'evolve.start')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) =>
    method === 'evolve.start' ? { run: evolveRunFixture() } : { hosts: [] }
  )
})
afterEach(cleanup)

describe('EvolveStartForm', () => {
  it('defaults to the email smoke target with no spec path field', () => {
    render(<EvolveStartForm tab={tab()} />)
    // The select's trigger and its native mirror both show the chosen target.
    expect(screen.getAllByText('Email replies — synthetic seat smoke').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Spec path')).toBeNull()
    expect(screen.getByLabelText('jev-lab checkout')).toHaveValue('~/Repos/jev-lab-evolve')
  })

  it('asks for a spec path when the target is a spec path, and refuses Start without one', async () => {
    render(<EvolveStartForm tab={tab({ target: 'spec' })} />)
    expect(screen.getByLabelText('Spec path')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start Evolve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Spec path')
    expect(startCalls()).toHaveLength(0)
  })

  it('starts on the chosen host for this tab and records the run on it', async () => {
    render(
      <EvolveStartForm
        tab={tab({
          iterations: '4',
          patience: '3',
          runsOnHost: 'mw0001',
          runsOnHostId: 'ssh:mw0001'
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start Evolve' }))
    await waitFor(() => expect(startCalls()).toHaveLength(1))
    expect(startCalls()[0]).toEqual([
      { kind: 'local' },
      'evolve.start',
      expect.objectContaining({
        target: 'email-smoke',
        iterations: 4,
        patience: 3,
        conversationId: 'evolve-tab',
        worktreeId: 'repo::/workspace',
        runsOn: 'fleet',
        runsOnHost: 'mw0001',
        runsOnHostId: 'ssh:mw0001'
      })
    ])
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('repo::/workspace', 'evolve-tab', {
        executionId: evolveRunFixture().id,
        prompt: 'Evolve email-smoke on mw0001'
      })
    )
    expect(mocks.title).toHaveBeenCalledWith('evolve-tab', 'Evolve email-smoke on mw0001')
  })

  it('shows a refused Start and keeps the form', async () => {
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'evolve.start') {
        throw new Error('No fleet host has spare capacity.')
      }
      return { hosts: [] }
    })
    render(<EvolveStartForm tab={tab()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start Evolve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No fleet host has spare capacity.')
    expect(screen.getByRole('button', { name: 'Start Evolve' })).toBeEnabled()
    expect(mocks.update).not.toHaveBeenCalledWith(
      'repo::/workspace',
      'evolve-tab',
      expect.objectContaining({ executionId: expect.anything() })
    )
  })

  it('refuses a non-number in Iterations by field', async () => {
    render(<EvolveStartForm tab={tab({ iterations: 'lots' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start Evolve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Iterations')
    expect(startCalls()).toHaveLength(0)
  })

  // Last: the runs store is shared, and the completed run it loads would leak into earlier tests.
  it('warm-starts a hosted run from the completed local winner', async () => {
    const winner = evolveRunFixture({ id: 'evo_local_winner', state: 'done' })
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'evolve.start') {
        return { run: evolveRunFixture() }
      }
      return method === 'evolve.list' ? { runs: [winner] } : { hosts: [] }
    })
    render(<EvolveStartForm tab={tab()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Warm-start from local winner' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start from local winner' }))
    await waitFor(() => expect(startCalls()).toHaveLength(1))
    expect(startCalls()[0]?.[2]).toEqual(
      expect.objectContaining({ runsOn: 'hosted', seedFromRunId: 'evo_local_winner' })
    )
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        'repo::/workspace',
        'evolve-tab',
        expect.objectContaining({ executionId: evolveRunFixture().id })
      )
    )
  })
})
