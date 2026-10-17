import { describe, expect, it, vi } from 'vitest'
import type {
  SessionSearchHit,
  SessionSearchHostStatus
} from '../../../../../shared/session-search-types'

vi.mock('@/lib/ai-vault-resume-target', () => ({
  getAiVaultResumeWorkspaceExecutionHostId: (_state: unknown, id: string): string =>
    id.startsWith('remote') ? 'runtime:env-1' : 'local'
}))

const { sessionSearchCoverageLine } = await import('./SessionContentSearchResults')
const { sessionSearchAccountHome, sessionSearchResumeWorkspace } =
  await import('./resume-session-search-hit')

const hit = (sessionId: string, overrides: Partial<SessionSearchHit> = {}): SessionSearchHit => ({
  sessionKey: `claude:${sessionId}`,
  sessionId,
  agent: 'claude',
  hostLabel: 'mac-studio',
  executionHostId: 'local',
  title: sessionId,
  cwd: null,
  transcriptPath: `/Users/me/.claude/projects/p/${sessionId}.jsonl`,
  lastActivityAt: null,
  score: 1,
  reasons: [],
  snippets: [],
  summary: null,
  summarySource: null,
  ...overrides
})

const host = (
  hostLabel: string,
  state: SessionSearchHostStatus['state'],
  pendingFiles?: number
): SessionSearchHostStatus => ({ hostLabel, executionHostId: hostLabel, state, pendingFiles })

describe('sessionSearchCoverageLine', () => {
  it('says nothing when every machine was searched', () => {
    expect(sessionSearchCoverageLine([host('mac-studio', 'searched')])).toBeNull()
  })

  it('folds many unsearched machines into one short line with the detail behind it', () => {
    const line = sessionSearchCoverageLine([
      host('mac-studio', 'searched'),
      host('mw0001', 'unsupported'),
      host('mw0002', 'unreachable'),
      host('laptop', 'indexing')
    ])
    expect(line?.text).toBe('laptop is still indexing · 2 machines not searched')
    expect(line?.detail.split('\n')).toHaveLength(3)
  })
})

describe('sessionSearchAccountHome', () => {
  it('names a numbered Claude profile and leaves the default home alone', () => {
    expect(
      sessionSearchAccountHome(
        hit('a', { transcriptPath: '/Users/me/.claude-account-5/projects/-Users-me/a.jsonl' })
      )
    ).toBe('/Users/me/.claude-account-5')
    expect(sessionSearchAccountHome(hit('a'))).toBeNull()
  })

  it('finds a Codex home above its dated sessions folder', () => {
    expect(
      sessionSearchAccountHome(
        hit('a', {
          agent: 'codex',
          transcriptPath: '/Users/me/.codex-work/sessions/2026/09/25/rollout-a.jsonl'
        })
      )
    ).toBe('/Users/me/.codex-work')
  })
})

describe('sessionSearchResumeWorkspace', () => {
  const state = {
    activeWorktreeId: 'active',
    folderWorkspaces: [{ id: 'f1', folderPath: '/Users/me/Work' }],
    worktreesByRepo: {
      r: [
        { id: 'repo', path: '/Users/me/Work/OmniRogue', repoId: 'r' },
        { id: 'remote-wt', path: '/Users/me/Work/OmniRogue/Marketing', repoId: 'r' }
      ]
    },
    repos: [],
    projectGroups: []
  } as unknown as Parameters<typeof sessionSearchResumeWorkspace>[0]

  it('picks the deepest workspace on the same host that holds the folder', () => {
    expect(
      sessionSearchResumeWorkspace(state, {
        cwd: '/Users/me/Work/OmniRogue/Marketing/',
        executionHostId: 'local'
      })
    ).toBe('repo')
  })

  it('falls back to the workspace in use when nothing holds the folder', () => {
    expect(sessionSearchResumeWorkspace(state, { cwd: '/tmp/x', executionHostId: 'local' })).toBe(
      'active'
    )
    expect(sessionSearchResumeWorkspace(state, { cwd: null, executionHostId: 'ssh:y' })).toBeNull()
  })
})
