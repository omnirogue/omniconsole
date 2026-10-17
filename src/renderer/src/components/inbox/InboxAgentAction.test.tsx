// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InboxAgentAction } from './InboxAgentAction'

const harness = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  send: vi.fn(),
  structuredSend: vi.fn(),
  failureMessage: vi.fn((status: string) => `selected target: ${status}`)
}))

vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => harness.sessions
}))
vi.mock('@/lib/active-agent-note-send', () => ({
  sendNotesToActiveAgentSession: harness.send,
  activeAgentNotesSendFailureMessage: harness.failureMessage
}))
vi.mock('./inbox-structured-instruction', () => ({
  sendInboxStructuredInstruction: harness.structuredSend
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))

const LOCAL_LEAF = '11111111-1111-4111-8111-111111111111'
const REMOTE_LEAF = '22222222-2222-4222-8222-222222222222'

function terminal(
  rowKey: string,
  label: string,
  worktreeId: string,
  tabId: string,
  leafId: string,
  unavailable = false
) {
  return {
    kind: 'terminal',
    rowKey,
    label,
    workspaceLabel: worktreeId,
    worktreeId,
    tabId,
    paneKey: `${tabId}:${leafId}`,
    unavailable
  }
}

beforeEach(() => {
  harness.sessions = [
    terminal('local-row', 'Local AI', 'wt-local', 'tab-local', LOCAL_LEAF),
    terminal('remote-row', 'Remote AI', 'wt-ssh', 'tab-remote', REMOTE_LEAF),
    terminal('offline-row', 'Offline AI', 'wt-offline', 'tab-offline', LOCAL_LEAF, true)
  ]
  harness.send.mockReset()
  harness.send.mockResolvedValue({ status: 'sent' })
  harness.structuredSend.mockReset()
  harness.structuredSend.mockResolvedValue(undefined)
  harness.failureMessage.mockClear()
})

afterEach(cleanup)

async function selectAgent(name: RegExp) {
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name }))
}

it('previews without sending and requires an explicit available AI selection', async () => {
  render(<InboxAgentAction instruction="Prepared request" close={vi.fn()} />)

  expect(screen.getByText('Prepared request')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send to my AI' })).toBeDisabled()
  expect(harness.send).not.toHaveBeenCalled()

  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
  expect(await screen.findByRole('option', { name: /Local AI/ })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /Remote AI/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /Offline AI/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('option', { name: /Local AI/ }))

  expect(screen.getByRole('button', { name: 'Send to my AI' })).toBeEnabled()
  expect(harness.send).not.toHaveBeenCalled()
})

it('forwards the selected remote worktree and pane and reports an instruction receipt', async () => {
  render(<InboxAgentAction instruction="Prepared request" close={vi.fn()} />)
  await selectAgent(/Remote AI/)

  fireEvent.click(screen.getByRole('button', { name: 'Send to my AI' }))

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Instruction sent to your AI. Refresh Inbox to check the actual delivery receipt.'
  )
  expect(harness.send).toHaveBeenCalledTimes(1)
  expect(harness.send).toHaveBeenCalledWith({
    worktreeId: 'wt-ssh',
    prompt: 'Prepared request',
    noteTarget: { tabId: 'tab-remote', leafId: REMOTE_LEAF }
  })
  expect(screen.getByRole('button', { name: 'Send to my AI' })).toBeDisabled()
})

it('sends a selected structured conversation through its structured session helper', async () => {
  const structured = {
    ...terminal('structured-row', 'Native AI', 'wt-native', 'tab-native', LOCAL_LEAF),
    kind: 'structured',
    paneKey: null,
    structuredSessionId: 'codex_thread-native',
    hostId: 'runtime:owner-one'
  }
  harness.sessions = [structured]
  render(<InboxAgentAction instruction="Prepared request" close={vi.fn()} />)
  await selectAgent(/Native AI/)

  fireEvent.click(screen.getByRole('button', { name: 'Send to my AI' }))

  expect(await screen.findByRole('status')).toHaveTextContent('actual delivery receipt')
  expect(harness.structuredSend).toHaveBeenCalledTimes(1)
  expect(harness.structuredSend).toHaveBeenCalledWith(structured, 'Prepared request')
  expect(harness.send).not.toHaveBeenCalled()
})

it('refuses a selection that becomes unavailable before send and permits a fresh choice', async () => {
  const view = render(<InboxAgentAction instruction="Prepared request" close={vi.fn()} />)
  await selectAgent(/Remote AI/)
  harness.sessions = [
    terminal('remote-row', 'Remote AI', 'wt-ssh', 'tab-remote', REMOTE_LEAF, true)
  ]
  view.rerender(<InboxAgentAction instruction="Prepared request" close={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: 'Send to my AI' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The selected conversation is no longer available.'
  )
  expect(harness.send).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Send to my AI' })).toBeEnabled()
})

it('does not retry an ambiguous partial submission', async () => {
  harness.send.mockResolvedValue({ status: 'partial-submit-failed' })
  render(<InboxAgentAction instruction="Prepared request" close={vi.fn()} />)
  await selectAgent(/Local AI/)

  fireEvent.click(screen.getByRole('button', { name: 'Send to my AI' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('delivery may be uncertain')
  expect(harness.failureMessage).toHaveBeenCalledWith('partial-submit-failed', {
    explicitTarget: true
  })
  expect(harness.send).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Send to my AI' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Send to my AI' }))
  expect(harness.send).toHaveBeenCalledTimes(1)
})
