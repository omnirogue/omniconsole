import { beforeEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from './sidebar-sessions'

const mocks = vi.hoisted(() => ({
  sendNotes: vi.fn(),
  sendStructured: vi.fn()
}))
vi.mock('./active-agent-note-send', async () => ({
  ...(await vi.importActual('./active-agent-note-send-result')),
  sendNotesToActiveAgentSession: mocks.sendNotes
}))
vi.mock('@/components/inbox/inbox-structured-instruction', () => ({
  sendInboxStructuredInstruction: mocks.sendStructured
}))

import { canReplyToSession, sendSessionReply } from './session-reply-send'

const LEAF = '11111111-2222-4333-8444-555555555555'

function session(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: null,
    worktreeId: 'wt-1',
    hostId: 'local',
    tabId: 'tab-1',
    paneKey: `tab-1:${LEAF}`,
    kind: 'terminal',
    label: 'Checkout fix',
    workspaceLabel: 'Shop',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

beforeEach(() => {
  mocks.sendNotes.mockReset()
  mocks.sendStructured.mockReset()
})

it('offers a reply only to a reachable terminal pane or structured session', () => {
  expect(canReplyToSession(session())).toBe(true)
  expect(canReplyToSession(session({ unavailable: true }))).toBe(false)
  expect(canReplyToSession(session({ tabId: null }))).toBe(false)
  expect(canReplyToSession(session({ kind: 'structured', structuredSessionId: 's-1' }))).toBe(true)
  expect(canReplyToSession(session({ kind: 'structured' }))).toBe(false)
})

it('sends a terminal reply to the thread’s own pane, not the focused one', async () => {
  mocks.sendNotes.mockResolvedValue({ status: 'sent' })
  await sendSessionReply(session(), 'Use the cheaper plan')
  expect(mocks.sendNotes).toHaveBeenCalledWith({
    worktreeId: 'wt-1',
    prompt: 'Use the cheaper plan',
    noteTarget: { tabId: 'tab-1', leafId: LEAF }
  })
})

it('says why when the agent did not take the reply', async () => {
  mocks.sendNotes.mockResolvedValue({ status: 'permission' })
  await expect(sendSessionReply(session(), 'go')).rejects.toThrow(
    'The selected agent needs permission.'
  )
})

it('sends a structured reply through the structured session', async () => {
  mocks.sendStructured.mockResolvedValue(undefined)
  const structured = session({
    kind: 'structured',
    structuredSessionId: 's-1'
  })
  await sendSessionReply(structured, 'go on')
  expect(mocks.sendStructured).toHaveBeenCalledWith(structured, 'go on')
  expect(mocks.sendNotes).not.toHaveBeenCalled()
})
