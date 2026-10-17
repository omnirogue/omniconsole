import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'
import { retainVerifiedClaudeIdentity, selectClaudeResumeIdentity } from './claude-resume-identity'
import { prepareClaudeResumeLaunch } from './claude-resume-launch'
import { restoreLedgerPane } from '../session-ledger/ledger-pane-restore'
import { LedgerPaneRegistry } from '../session-ledger/ledger-identity'
import type { PersistedPane } from '../session-ledger/ledger-pane-store'

let root: string
let verified: AgentProviderSessionMetadata
let pending: AgentProviderSessionMetadata
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-resume-identity-'))
  const project = join(root, '.claude-account-5', 'projects', '-repo')
  mkdirSync(project, { recursive: true })
  verified = {
    key: 'session_id',
    id: 'real-session',
    transcriptPath: join(project, 'real-session.jsonl')
  }
  pending = {
    key: 'session_id',
    id: 'helper-session',
    transcriptPath: join(project, 'helper-session.jsonl')
  }
  writeFileSync(verified.transcriptPath!, '{}\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('verified Claude restore identity', () => {
  it('retains the last verified session until the new transcript appears', () => {
    const captured = retainVerifiedClaudeIdentity(pending, verified)
    expect(selectClaudeResumeIdentity(normalizeAgentProviderSession(captured)!)).toEqual(verified)
    writeFileSync(pending.transcriptPath!, '{}\n')
    expect(selectClaudeResumeIdentity(captured)?.id).toBe(pending.id)
  })

  it('rechecks fallback files and refuses a known missing transcript without one', () => {
    const captured = retainVerifiedClaudeIdentity(pending, verified)
    rmSync(verified.transcriptPath!)
    expect(selectClaudeResumeIdentity(captured)).toBeNull()
    expect(selectClaudeResumeIdentity({ key: 'session_id', id: 'legacy' })?.id).toBe('legacy')
  })

  it('replaces the resume selector and pins the original profile instead of launch defaults', async () => {
    const args = {
      command: "claude --resume 'helper-session'",
      env: { CLAUDE_CONFIG_DIR: '/wrong-account' },
      resumeProviderSession: retainVerifiedClaudeIdentity(pending, verified)
    }
    await prepareClaudeResumeLaunch(args)
    expect(args.command).toContain('real-session')
    expect(args.command).not.toContain('helper-session')
    expect(args.env.CLAUDE_CONFIG_DIR).toBe(join(root, '.claude-account-5'))
    expect(args.resumeProviderSession.id).toBe('real-session')
  })

  it('does not explicitly pin the CLI default config directory', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, '.claude-account-5'))
    try {
      const args = {
        command: 'claude --resume real-session',
        env: { CLAUDE_CONFIG_DIR: '/wrong' },
        resumeProviderSession: verified
      }
      await prepareClaudeResumeLaunch(args)
      expect(args.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('persists a verified ledger identity and restores it when a newer file vanished', () => {
    let saved: PersistedPane[] = []
    const registry = new LedgerPaneRegistry({
      load: () => saved,
      save: (rows) => {
        saved = rows
      }
    })
    registry.stamp('pane', { ptyId: 'pty', worktreeId: 'workspace' })
    registry.update('pane', {
      agent: 'claude',
      nativeSessionKey: 'session_id',
      connectionId: null,
      nativeSessionId: verified.id,
      sessionFilePath: verified.transcriptPath
    })
    registry.update('pane', {
      nativeSessionId: pending.id,
      sessionFilePath: pending.transcriptPath
    })
    expect(saved[0].resumeIdentity?.nativeSessionId).toBe(verified.id)
    const newer = {
      ...saved[0],
      resumeIdentity: {
        ...saved[0].resumeIdentity!,
        nativeSessionId: pending.id,
        sessionFilePath: pending.transcriptPath
      }
    }
    expect(restoreLedgerPane(newer).nativeSessionId).toBe(verified.id)
  })
})
