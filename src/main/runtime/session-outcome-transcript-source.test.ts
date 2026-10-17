import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionTab } from '../native-chat/agent-session-wire/structured-agent-session-host-tabs'
import {
  providerSessionOutcomeTranscriptSource,
  structuredSessionOutcomeTranscriptSource
} from './session-outcome-transcript-source'

const PANE_KEY = 'source-tab:source-pane'
const WORKSPACE_ID = 'folder:outcome'
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'provider-session',
  transcriptPath: '/transcripts/provider-session.jsonl'
}

function hookRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    worktreeId: WORKSPACE_ID,
    connectionId: null,
    state: 'working',
    prompt: 'Send the session transcript when done.',
    agentType: 'claude',
    providerSession: PROVIDER_SESSION,
    receivedAt: 100,
    stateStartedAt: 100,
    ...overrides
  }
}

describe('providerSessionOutcomeTranscriptSource', () => {
  it('pins the exact provider identity and path from the local source pane', () => {
    expect(providerSessionOutcomeTranscriptSource([hookRow()], PANE_KEY, WORKSPACE_ID)).toEqual({
      kind: 'provider',
      hostId: 'local',
      agent: 'claude',
      sessionId: PROVIDER_SESSION.id,
      transcriptPath: PROVIDER_SESSION.transcriptPath
    })
  })

  it('allows a provider identity without a reported transcript path', () => {
    const row = hookRow({ providerSession: { key: 'session_id', id: 'provider-session' } })
    expect(providerSessionOutcomeTranscriptSource([row], PANE_KEY, WORKSPACE_ID)).toEqual({
      kind: 'provider',
      hostId: 'local',
      agent: 'claude',
      sessionId: 'provider-session'
    })
  })

  it.each<{ label: string; overrides: Partial<AgentStatusIpcPayload> }>([
    { label: 'another pane', overrides: { paneKey: 'other-tab:other-pane' } },
    { label: 'another workspace', overrides: { worktreeId: 'folder:other' } },
    { label: 'an unknown workspace', overrides: { worktreeId: undefined } },
    { label: 'an SSH connection', overrides: { connectionId: 'remote-host' } },
    { label: 'no provider session', overrides: { providerSession: undefined } },
    { label: 'no agent', overrides: { agentType: undefined } },
    { label: 'an empty session ID', overrides: { providerSession: { key: 'session_id', id: '' } } }
  ])('does not select a transcript from $label', ({ overrides }) => {
    expect(
      providerSessionOutcomeTranscriptSource([hookRow(overrides)], PANE_KEY, WORKSPACE_ID)
    ).toBeUndefined()
  })

  it('requires explicit local transport evidence', () => {
    const row = hookRow()
    Reflect.deleteProperty(row, 'connectionId')
    expect(providerSessionOutcomeTranscriptSource([row], PANE_KEY, WORKSPACE_ID)).toBeUndefined()
  })

  it.each<{ label: string; overrides: Partial<AgentStatusIpcPayload> }>([
    {
      label: 'session ID',
      overrides: { providerSession: { ...PROVIDER_SESSION, id: 'another-session' } }
    },
    {
      label: 'transcript path',
      overrides: {
        providerSession: { ...PROVIDER_SESSION, transcriptPath: '/transcripts/another.jsonl' }
      }
    },
    {
      label: 'provider identity key',
      overrides: { providerSession: { ...PROVIDER_SESSION, key: 'conversation_id' } }
    },
    { label: 'agent', overrides: { agentType: 'codex' } }
  ])('refuses conflicting $label even when one observation is newer', ({ overrides }) => {
    const rows = [hookRow(), hookRow({ ...overrides, receivedAt: 200 })]
    expect(providerSessionOutcomeTranscriptSource(rows, PANE_KEY, WORKSPACE_ID)).toBeUndefined()
  })

  it('allows repeated observations of one identity without borrowing unrelated rows', () => {
    const source = providerSessionOutcomeTranscriptSource([hookRow()], PANE_KEY, WORKSPACE_ID)
    const rows = [
      hookRow(),
      hookRow({ receivedAt: 200, state: 'done' }),
      hookRow({ paneKey: 'other-pane', providerSession: { key: 'session_id', id: 'other' } }),
      hookRow({ connectionId: 'remote-host', providerSession: { key: 'session_id', id: 'remote' } })
    ]
    expect(providerSessionOutcomeTranscriptSource(rows, PANE_KEY, WORKSPACE_ID)).toEqual(source)
  })

  it('returns no source when the host has no provider observation', () => {
    expect(providerSessionOutcomeTranscriptSource([], PANE_KEY, WORKSPACE_ID)).toBeUndefined()
  })
})

describe('structuredSessionOutcomeTranscriptSource', () => {
  const session: StructuredAgentSessionTab = {
    sessionId: 'structured-session',
    workspaceId: WORKSPACE_ID,
    agent: 'codex'
  }
  const paneKey = structuredAgentSessionPaneKey(
    structuredAgentSessionTabId(session.sessionId),
    session.sessionId
  )

  it('derives the host-owned structured session from its exact workspace and pane', () => {
    expect(structuredSessionOutcomeTranscriptSource([session], paneKey, WORKSPACE_ID)).toEqual({
      kind: 'structured',
      hostId: 'local',
      agent: 'codex',
      sessionId: session.sessionId
    })
  })

  it('rejects a different workspace, pane, or session identity', () => {
    expect(
      structuredSessionOutcomeTranscriptSource([session], paneKey, 'folder:other')
    ).toBeUndefined()
    expect(
      structuredSessionOutcomeTranscriptSource([session], 'other-pane', WORKSPACE_ID)
    ).toBeUndefined()
    expect(
      structuredSessionOutcomeTranscriptSource(
        [{ ...session, sessionId: 'other-session' }],
        paneKey,
        WORKSPACE_ID
      )
    ).toBeUndefined()
  })

  it('requires exactly one host-owned structured session match', () => {
    expect(structuredSessionOutcomeTranscriptSource([], paneKey, WORKSPACE_ID)).toBeUndefined()
    expect(
      structuredSessionOutcomeTranscriptSource([session, { ...session }], paneKey, WORKSPACE_ID)
    ).toBeUndefined()
  })
})
