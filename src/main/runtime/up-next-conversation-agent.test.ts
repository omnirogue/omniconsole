/**
 * The agent a conversation is talking to when its pane record cannot say.
 *
 * A chat session has no PTY, so the pane record every other reading comes from does not
 * exist for it. Up next needs the agent all the same: a stage runs on a named actor, and a
 * commit that cannot name one is refused (`needsAgent`) — which is why an Agent block could
 * not be queued on any chat session at all, and why a move or remove recommit of one
 * silently re-planned the work onto `claude`. An agent started from a shell has a PTY but no
 * launch record, and while idle no foreground reading: its own hooks name it, or the work
 * held behind a review was refused forever once the reviewer approved.
 */
import { describe, expect, it } from 'vitest'

import type { StructuredAgentSessionTab } from '../native-chat/agent-session-wire/structured-agent-session-host-tabs'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './omni-runtime'
import { structuredConversationAgent } from './up-next-conversation-agent'

const tab = (
  sessionId: string,
  agent: StructuredAgentSessionTab['agent']
): StructuredAgentSessionTab => ({
  sessionId,
  workspaceId: 'wt',
  agent
})

const paneOf = (sessionId: string): string =>
  structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)

describe('the agent of a structured conversation', () => {
  it('reads the agent of the session whose own pane key this is', () => {
    const tabs = [tab('session-a', 'codex'), tab('session-b', 'claude')]

    expect(structuredConversationAgent(paneOf('session-b'), tabs)).toBe('claude')
    expect(structuredConversationAgent(paneOf('session-a'), tabs)).toBe('codex')
  })

  it('answers nothing rather than a guess', () => {
    // No session owns this pane (a PTY conversation, or one that has gone away), no session
    // host at all, and — the case a guess would be worst — two sessions claiming one pane.
    expect(structuredConversationAgent('tab-1:leaf-1', [tab('session-a', 'codex')])).toBeNull()
    expect(structuredConversationAgent(paneOf('session-a'), [])).toBeNull()
    expect(
      structuredConversationAgent(paneOf('session-a'), [
        tab('session-a', 'codex'),
        tab('session-a', 'gemini')
      ])
    ).toBeNull()
  })
})

/** The real runtime methods over only the collaborators the reading uses. */
function runtimeWith(fields: Record<string, unknown>): OrcaRuntimeService {
  return Object.assign(Object.create(OrcaRuntimeService.prototype), fields) as OrcaRuntimeService
}

const hookRow = (over: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload =>
  ({
    paneKey: 'tab-1:leaf-1',
    state: 'done',
    prompt: '',
    agentType: 'claude',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    ...over
  }) as AgentStatusIpcPayload

describe('the runtime reading Up next uses', () => {
  it('asks the structured session host when there is no pane record', () => {
    const pane = paneOf('session-a')
    setStructuredAgentSessionHost({
      listSessionTabs: () => [tab('session-a', 'codex')]
    } as never)
    try {
      // The real method, with the one collaborator it reads: no PTY for this pane.
      const runtime = runtimeWith({ getPtyRecordForPaneKey: () => undefined })
      expect(runtime.conversationAgent(pane)).toBe('codex')
      // A PTY conversation still answers from its own pane record, and an unknown pane is null.
      const pty = runtimeWith({ getPtyRecordForPaneKey: () => ({ launchAgent: 'claude' }) })
      expect(pty.conversationAgent(pane)).toBe('claude')
      expect(runtime.conversationAgent('tab-1:leaf-1')).toBeNull()
    } finally {
      setStructuredAgentSessionHost(null)
    }
  })

  it('names the agent an idle pane started from a shell reports through its own hooks', () => {
    // `omni terminal create --command "claude …"`: no launch agent, and idle, so no foreground one.
    const idle = { launchAgent: undefined, foregroundAgent: undefined }
    const withRows = (rows: AgentStatusIpcPayload[]) =>
      runtimeWith({
        getPtyRecordForPaneKey: () => idle,
        getAgentProviderSessionRowsForPaneFn: () => rows
      })
    // A fresh hook row names it.
    expect(withRows([hookRow({ agentType: 'codex' })]).conversationAgent('tab-1:leaf-1')).toBe(
      'codex'
    )
    // Hours into a reviewer's wait the status row is stale; the provider session row still names it.
    const hoursAgo = Date.now() - 6 * AGENT_STATUS_STALE_AFTER_MS
    const session = hookRow({
      agentType: 'claude',
      receivedAt: hoursAgo,
      stateStartedAt: hoursAgo,
      providerSession: { key: 'session_id', id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31' }
    })
    expect(withRows([session]).conversationAgent('tab-1:leaf-1')).toBe('claude')
    // A row that names no agent this host runs is not a reading.
    expect(
      withRows([hookRow({ agentType: 'not-an-agent' })]).conversationAgent('tab-1:leaf-1')
    ).toBeNull()
    expect(withRows([]).conversationAgent('tab-1:leaf-1')).toBeNull()
  })
})
