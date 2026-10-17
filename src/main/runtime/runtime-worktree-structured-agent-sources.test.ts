import { describe, expect, it } from 'vitest'
import { structuredWorktreeAgentSources } from './runtime-worktree-structured-agent-sources'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-freshness'

const summary: AgentSessionStatusSummary = {
  sessionId: 'background',
  workspaceId: 'folder-workspace',
  agent: 'codex',
  status: 'working',
  latestPrompt: 'work',
  updatedAt: 1,
  hostExecutionOwned: true
}
describe('host structured sessions in worktree ps', () => {
  it('lists host-held background work without a terminal or renderer tab', () => {
    const [row] = structuredWorktreeAgentSources([summary])
    expect(row).toMatchObject({
      worktreeId: 'folder-workspace',
      state: 'working',
      structuredHostOwned: true
    })
    expect(isFreshNonDoneAgentStatus(row, 1e12)).toBe(true)
    expect(row).not.toHaveProperty('ptyId')
  })
  it('keeps watchers separate from execution and preserves requests and failures', () => {
    expect(
      structuredWorktreeAgentSources([{ ...summary, workingMode: 'monitoring' }])[0]
    ).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(structuredWorktreeAgentSources([{ ...summary, status: 'attention' }])[0].state).toBe(
      'blocked'
    )
    expect(
      structuredWorktreeAgentSources([{ ...summary, status: 'idle', failed: true }])[0]
    ).toMatchObject({ state: 'done', failed: true })
  })
  it('does not treat readable history without an owner as running', () => {
    const [row] = structuredWorktreeAgentSources([{ ...summary, hostExecutionOwned: undefined }])
    expect(isFreshNonDoneAgentStatus(row, 1)).toBe(false)
    expect(structuredWorktreeAgentSources([])).toEqual([])
  })
})
