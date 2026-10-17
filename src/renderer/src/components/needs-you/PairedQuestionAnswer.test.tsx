// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  SESSION_QUESTION_OWNER_ANSWER_CAPABILITY,
  SESSION_QUESTION_OWNER_RPC
} from '../../../../shared/session-question-owner-answer'

const mocks = vi.hoisted(() => ({ state: {} as ReturnType<typeof fixture>, rpc: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))

import { PairedQuestionAnswer } from './PairedQuestionAnswer'

const leaf = '11111111-2222-4333-8444-555555555555'
const tab = toWebTerminalSurfaceTabId('host-tab')
const pane = makePaneKey(tab, leaf)
const environment = { id: 'rental', createdAt: 100, pairingRevision: 101 }
const target = {
  worktreeId: 'folder:work',
  paneKey: makePaneKey('host-tab', leaf),
  terminal: 'term-1'
}
const binding = {
  runtimeId: 'runtime-1',
  fingerprint: 'a'.repeat(64),
  ownerFingerprint: 'b'.repeat(64)
}
const ready = {
  runtimeId: 'runtime-1',
  target,
  status: 'ready',
  binding,
  question: {
    text: 'Which color?',
    options: [
      { n: 1, label: 'Blue' },
      { n: 7, label: 'Green' }
    ],
    acceptsText: false
  }
}

function fixture() {
  return {
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([
      [
        'rental',
        {
          status: {
            runtimeId: 'runtime-1',
            capabilities: [SESSION_QUESTION_OWNER_ANSWER_CAPABILITY]
          },
          connectionGeneration: 3
        }
      ]
    ]),
    unifiedTabsByWorktree: {
      'folder:work': [
        {
          id: tab,
          worktreeId: 'folder:work',
          contentType: 'terminal',
          executionHostId: 'runtime:rental'
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tab]: { ptyIdsByLeafId: { [leaf]: toRemoteRuntimePtyId('term-1', 'rental') } }
    },
    agentStatusByPaneKey: {
      [pane]: {
        paneKey: pane,
        tabId: tab,
        worktreeId: 'folder:work',
        terminalHandle: 'term-1',
        agentType: 'claude',
        state: 'waiting',
        stateStartedAt: 1000,
        toolName: 'AskUserQuestion',
        providerSession: { key: 'session_id', id: 'provider-1' },
        interactivePrompt: JSON.stringify({
          questions: [
            { question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Green' }] }
          ]
        })
      }
    }
  }
}

beforeEach(() => {
  mocks.state = fixture()
  replaceRuntimeEnvironmentRevisions([environment])
  mocks.rpc.mockImplementation(async (_owner, method) =>
    method === SESSION_QUESTION_OWNER_RPC.read
      ? ready
      : {
          runtimeId: 'runtime-1',
          target,
          status: 'answered',
          binding,
          delivery: 'confirmed',
          summary: 'Answered.'
        }
  )
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function show() {
  return render(<PairedQuestionAnswer paneKey={pane} summary="Which color?" />)
}
async function green() {
  return screen.findByRole('button', { name: /Green/ })
}

it('renders owner-verified choices and sends the displayed binding exactly once to that owner', async () => {
  show()
  const button = await green()
  expect(screen.queryByPlaceholderText('Type your answer')).toBeNull()
  fireEvent.click(button)
  fireEvent.click(button)
  await screen.findByText('Answer sent.')
  expect(mocks.rpc.mock.calls.map((call) => call[1])).toEqual([
    SESSION_QUESTION_OWNER_RPC.read,
    SESSION_QUESTION_OWNER_RPC.answer
  ])
  const call = mocks.rpc.mock.calls[1]!
  expect(call[0]).toEqual({ kind: 'environment', environmentId: 'rental' })
  expect(call[2]).toMatchObject({
    runtimeId: 'runtime-1',
    target,
    binding,
    answer: { kind: 'choose', choice: 7 }
  })
  expect(call[2].displayed.providerSession.id).toBe('provider-1')
  expect(call[3].expectedEnvironmentPairingRevision).toBe(101)
  expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
})

it('never calls a legacy host or falls back to raw terminal input', async () => {
  mocks.state.runtimeStatusByEnvironmentId.get('rental')!.status.capabilities = []
  show()
  await screen.findByText(/Update this session’s computer/)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
})

it('sends free text only when the execution owner offers it', async () => {
  mocks.rpc.mockImplementation(async (_owner, method) =>
    method === SESSION_QUESTION_OWNER_RPC.read
      ? { ...ready, question: { ...ready.question, acceptsText: true, options: [] } }
      : {
          runtimeId: 'runtime-1',
          target,
          status: 'answered',
          binding,
          delivery: 'confirmed',
          summary: 'Answered.'
        }
  )
  show()
  fireEvent.change(await screen.findByPlaceholderText('Type your answer'), {
    target: { value: 'Use the blue marker' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
  await screen.findByText('Answer sent.')
  expect(mocks.rpc.mock.calls[1]![2].answer).toEqual({ kind: 'text', text: 'Use the blue marker' })
})

it('rejects replacement provider identity with the same prompt before a click', async () => {
  show()
  const button = await green()
  mocks.state.agentStatusByPaneKey[pane]!.providerSession.id = 'replacement'
  fireEvent.click(button)
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))
  expect(mocks.rpc.mock.calls.every((call) => call[1] === SESSION_QUESTION_OWNER_RPC.read)).toBe(
    true
  )
  expect(mocks.rpc.mock.calls[1]![2].displayed.providerSession.id).toBe('replacement')
})

it('does not adopt a read response after a connection generation changes', async () => {
  let resolve!: (value: unknown) => void
  mocks.rpc.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  show()
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
  mocks.state.runtimeStatusByEnvironmentId.get('rental')!.connectionGeneration++
  resolve(ready)
  await screen.findByText(/question or its session changed|Checking the question/)
  expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
})

it('keeps a host-side stale refusal visible without re-reading or sending another answer', async () => {
  mocks.rpc.mockImplementation(async (_owner, method) =>
    method === SESSION_QUESTION_OWNER_RPC.read
      ? ready
      : {
          runtimeId: 'runtime-1',
          target,
          status: 'refused',
          code: 'stale-question',
          message: 'The owner moved to another question. Nothing was sent.'
        }
  )
  show()
  fireEvent.click(await green())
  await screen.findByText(
    'The question could not be verified. Open the session to check it. Nothing was sent.'
  )
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
})

it.each(['recorded', 'unconfirmed'])(
  'does not call %s delivery confirmed or offer an automatic retry',
  async (delivery) => {
    mocks.rpc.mockImplementation(async (_owner, method) =>
      method === SESSION_QUESTION_OWNER_RPC.read
        ? ready
        : {
            runtimeId: 'runtime-1',
            target,
            status: 'answered',
            binding,
            delivery,
            summary: 'Recorded.'
          }
    )
    show()
    fireEvent.click(await green())
    await screen.findByText(/delivery isn’t confirmed/)
    expect(screen.queryByText('Answer sent.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  }
)

it('treats a missing or mismatched receipt as uncertain without retry', async () => {
  mocks.rpc.mockImplementation(async (_owner, method) =>
    method === SESSION_QUESTION_OWNER_RPC.read
      ? ready
      : {
          runtimeId: 'other-runtime',
          target,
          status: 'answered',
          binding,
          delivery: 'confirmed',
          summary: 'Done.'
        }
  )
  show()
  fireEvent.click(await green())
  await screen.findByText(/Couldn’t confirm delivery/)
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Answer sent.')).toBeNull()
})

it('refuses a malformed owner read rather than rendering unbound options', async () => {
  mocks.rpc.mockResolvedValue({ ...ready, binding: { ...binding, runtimeId: 'other-runtime' } })
  show()
  await screen.findByText(/question or its session changed/)
  expect(screen.queryByRole('button', { name: /Green/ })).toBeNull()
})
