import { describe, expect, it } from 'vitest'
import { resolveConversationStart } from './start-conversation'

const base = {
  activeWorktreeId: 'repo::/w/one',
  activeGroupIdByWorktree: { 'repo::/w/one': 'group-a' },
  groupsByWorktree: { 'repo::/w/one': [{ id: 'group-first' }, { id: 'group-a' }] },
  defaultTuiAgent: 'claude' as const,
  detectedAgentIds: ['claude', 'codex'] as const,
  disabledTuiAgents: [] as const
}

describe('where a new conversation starts', () => {
  it('starts in the workspace and group the person is looking at', () => {
    const start = resolveConversationStart(base)
    expect(start).toEqual({
      ok: true,
      agent: 'claude',
      worktreeId: 'repo::/w/one',
      groupId: 'group-a'
    })
  })

  it('falls back to the first group of a workspace that was never focused', () => {
    const start = resolveConversationStart({ ...base, activeGroupIdByWorktree: {} })
    expect(start.ok && start.groupId).toBe('group-first')
  })

  // Why: the control has to say why it is inert. A dead button teaches nothing.
  it('refuses with no workspace open', () => {
    const start = resolveConversationStart({ ...base, activeWorktreeId: null })
    expect(start).toEqual({ ok: false, reason: 'no-workspace' })
  })

  it('refuses when no agent is available', () => {
    const start = resolveConversationStart({ ...base, detectedAgentIds: [], defaultTuiAgent: null })
    expect(start).toEqual({ ok: false, reason: 'no-agent' })
  })

  it('never picks an agent the person disabled', () => {
    const start = resolveConversationStart({
      ...base,
      defaultTuiAgent: 'claude',
      disabledTuiAgents: ['claude']
    })
    expect(start.ok && start.agent).not.toBe('claude')
  })

  it('treats a blank default as no preference rather than an agent', () => {
    const start = resolveConversationStart({ ...base, defaultTuiAgent: 'blank' })
    expect(start.ok).toBe(true)
    expect(start.ok && start.agent).toBe('claude')
  })
})
