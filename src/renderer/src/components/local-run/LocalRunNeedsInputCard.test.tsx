// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalRunNodeSnapshot, LocalRunSnapshot } from '../../../../shared/local-run-types'
import { LocalRunNeedsInputCard } from './LocalRunNeedsInputCard'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, english: string) => english }))

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({ run: { nodes: [] } })
})

function node(patch: Partial<LocalRunNodeSnapshot>): LocalRunNodeSnapshot {
  return {
    id: 'publish',
    actor: { agent: 'codex' },
    presetId: 'implement',
    state: 'needs-input',
    taskId: 'task_1',
    dispatchId: null,
    terminalHandle: null,
    placement: null,
    reportPath: null,
    outputDir: null,
    manifestPath: null,
    producedFiles: [],
    gateId: null,
    gateQuestion: null,
    question: null,
    deliveryId: null,
    error: null,
    ...patch
  }
}

function run(nodes: LocalRunNodeSnapshot[]): LocalRunSnapshot {
  return {
    id: 'lrn_1',
    runId: 'run_1',
    workspacePath: '/work/brief',
    workspaceId: 'workspace:1',
    workspaceKind: 'folder',
    coordinatorTerminalHandle: 'term_coord',
    stage: 'running',
    maxConcurrent: 3,
    graph: { nodes: [], workspacePath: '/work/brief' },
    nodes,
    events: [],
    error: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z'
  }
}

describe('LocalRunNeedsInputCard', () => {
  it('shows nothing when no node is waiting on a person', () => {
    const { container } = render(<LocalRunNeedsInputCard run={run([node({ state: 'running' })])} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('resolves a gated node through the gate RPC', async () => {
    const onAnswered = vi.fn()
    render(
      <LocalRunNeedsInputCard
        run={run([node({ gateId: 'gate_1', gateQuestion: 'Publish this cut?' })])}
        onAnswered={onAnswered}
      />
    )
    expect(screen.getByText('Publish this cut?')).toBeInTheDocument()
    expect(screen.getByText('publish · Needs input')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: '  yes  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'localRun.resolveGate', {
        id: 'lrn_1',
        gateId: 'gate_1',
        resolution: 'yes'
      })
    )
    expect(onAnswered).toHaveBeenCalled()
  })

  it("replies to the worker's own question instead of opening a gate", async () => {
    render(
      <LocalRunNeedsInputCard
        run={run([
          node({
            question: {
              messageId: 'msg_1',
              source: 'mailbox' as const,
              question: 'Which codec?',
              options: ['h264', 'prores'],
              askedAt: '2026-09-10T00:00:00.000Z'
            }
          })
        ])}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'prores' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'localRun.reply', {
        id: 'lrn_1',
        messageId: 'msg_1',
        body: 'prores'
      })
    )
  })

  it('reports a refused answer instead of pretending it landed', async () => {
    mocks.call.mockRejectedValue(new Error('gate already resolved'))
    render(<LocalRunNeedsInputCard run={run([node({ gateId: 'gate_1', gateQuestion: 'Go?' })])} />)
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'yes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('gate already resolved')
    )
  })
})
