import { describe, expect, it } from 'vitest'
import { conversationViewKey } from './conversation-view'
import type { SidebarSession } from './sidebar-sessions'
import {
  filterSessionsByAgent,
  SESSION_AGENT_FILTER_IDS,
  sessionAgentFilterId
} from './session-agent-filter'

function session(id: string, agent: string): SidebarSession {
  return {
    rowKey: id,
    sessionKey: null,
    worktreeId: 'wt',
    hostId: null,
    tabId: id,
    paneKey: null,
    kind: 'terminal',
    label: id,
    workspaceLabel: 'wt',
    agent,
    unavailable: false,
    folderKeyMigration: null
  } as SidebarSession
}

describe('session agent filter', () => {
  it('offers the six agents in Sal’s order', () => {
    expect(SESSION_AGENT_FILTER_IDS).toEqual(['claude', 'codex', 'grok', 'kimi', 'gemini', 'omp'])
  })
  it('counts agent teams as Claude and ignores agents without a button', () => {
    expect(sessionAgentFilterId('claude-agent-teams')).toBe('claude')
    expect(sessionAgentFilterId('claude')).toBe('claude')
    expect(sessionAgentFilterId('aider')).toBeNull()
    expect(sessionAgentFilterId('Agent')).toBeNull()
  })
  it('keeps one agent’s unarchived sessions and nothing else while pressed', () => {
    const claude = session('a', 'claude')
    const teams = session('b', 'claude-agent-teams')
    const archivedClaude = session('c', 'claude')
    const codex = session('d', 'codex')
    const sessions = [claude, teams, archivedClaude, codex]
    const archived = new Set([conversationViewKey(archivedClaude)])
    expect(filterSessionsByAgent(sessions, 'claude', archived)).toEqual([claude, teams])
    expect(filterSessionsByAgent(sessions, 'codex', archived)).toEqual([codex])
    expect(filterSessionsByAgent(sessions, 'kimi', archived)).toEqual([])
  })
  it('passes the list through untouched when no logo is pressed', () => {
    const sessions = [session('a', 'claude'), session('b', 'grok')]
    expect(filterSessionsByAgent(sessions, null, new Set(['a']))).toBe(sessions)
  })
})
