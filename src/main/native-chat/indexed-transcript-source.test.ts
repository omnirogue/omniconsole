import { describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_AGENTS,
  type AiVaultListResult,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import {
  findIndexedTranscriptSource,
  resolveIndexedTranscriptFilePath,
  validateIndexedTranscriptIdentity
} from './indexed-transcript-source'

describe('findIndexedTranscriptSource', () => {
  it.each(AI_VAULT_AGENTS)('resolves the exact indexed %s provider session', (agent) => {
    const session = sessionRow({ agent })
    Object.defineProperty(session, 'previewMessages', {
      get: () => {
        throw new Error('A preview is not a transcript source')
      }
    })
    expect(findIndexedTranscriptSource(index([session]), agent, 'wanted')).toEqual({
      agent,
      sessionId: 'wanted',
      filePath: '/host/transcript.jsonl'
    })
  })

  it.each(['openclaude', 'claude-agent-teams'])('uses the Claude index for %s', (agent) => {
    expect(
      findIndexedTranscriptSource(index([sessionRow({ agent: 'claude' })]), agent, 'wanted')
    ).toEqual({ agent: 'claude', sessionId: 'wanted', filePath: '/host/transcript.jsonl' })
  })

  it('requires exact provider, session ID, and owning host rather than matching filenames', () => {
    const result = index([
      sessionRow({ agent: 'claude' }),
      sessionRow({ sessionId: 'wanted-extra', filePath: '/host/wanted.jsonl' }),
      sessionRow({ executionHostId: 'ssh:other', filePath: '/other/wanted.jsonl' })
    ])
    expect(findIndexedTranscriptSource(result, 'codex', 'wanted')).toBeNull()
    expect(findIndexedTranscriptSource(result, 'codex', 'wanted', 'ssh:other')).toEqual({
      agent: 'codex',
      sessionId: 'wanted',
      filePath: '/other/wanted.jsonl'
    })
  })

  it('collapses identical source rows but refuses distinct files for the same identity', () => {
    const source = sessionRow()
    expect(findIndexedTranscriptSource(index([source, source]), 'codex', 'wanted')).toEqual({
      agent: 'codex',
      sessionId: 'wanted',
      filePath: source.filePath
    })
    expect(() =>
      findIndexedTranscriptSource(
        index([source, sessionRow({ filePath: '/host/another.jsonl' })]),
        'codex',
        'wanted'
      )
    ).toThrow(/Ambiguous transcript source/)
  })

  it.each(['', '  ', '../relative.jsonl', '/host/\0invalid.jsonl', 'x'.repeat(32_769)])(
    'rejects a matching index row without a usable path',
    (filePath) => {
      expect(() =>
        findIndexedTranscriptSource(index([sessionRow({ filePath })]), 'codex', 'wanted')
      ).toThrow(/index unavailable/)
    }
  )

  it.each([undefined, 'host', 'scope'] as const)(
    'does not call a partial %s index a healthy miss',
    (kind) => {
      const result = index(
        [],
        [{ agent: 'codex', kind, path: '/host/sessions', message: 'source not readable' }]
      )
      expect(() => findIndexedTranscriptSource(result, 'codex', 'wanted')).toThrow(
        /index unavailable/
      )
    }
  )

  it('refuses a partial provider index even when one matching path was found', () => {
    const result = index(
      [sessionRow()],
      [{ agent: 'codex', path: '/host/second-root', message: 'could not scan' }]
    )
    expect(() => findIndexedTranscriptSource(result, 'codex', 'wanted')).toThrow(
      /index unavailable/
    )
  })

  it('does not let a cancelled scan establish absence', () => {
    expect(() =>
      findIndexedTranscriptSource({ ...index(), cancelled: true }, 'codex', 'wanted')
    ).toThrow(/index unavailable/)
  })

  it('ignores other providers, foreign hosts, and non-failure notices', () => {
    const result = index(
      [],
      [
        { agent: 'claude', path: '/host/claude', message: 'unrelated' },
        { agent: 'codex', executionHostId: 'ssh:other', kind: 'host', path: '/', message: 'other' },
        { agent: 'codex', kind: 'notice', path: '/', message: 'commentary' }
      ]
    )
    expect(findIndexedTranscriptSource(result, 'codex', 'wanted')).toBeNull()
  })

  it('treats host failures as unavailable regardless of the placeholder provider', () => {
    const result = index([], [{ agent: 'codex', kind: 'host', path: '/', message: 'host failed' }])
    expect(() => findIndexedTranscriptSource(result, 'kimi', 'wanted')).toThrow(/index unavailable/)
  })
})

describe('resolveIndexedTranscriptFilePath', () => {
  it('uses the injected host-local cached index without forcing a known hit', async () => {
    const listSessions = vi.fn().mockResolvedValue(index([sessionRow()]))
    const signal = new AbortController().signal
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', { listSessions, signal })
    ).resolves.toBe('/host/transcript.jsonl')
    expect(listSessions).toHaveBeenCalledExactlyOnceWith({ unlimited: true }, { signal })
  })

  it('refreshes a healthy miss once to find a newly persisted session', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(index())
      .mockResolvedValueOnce(index([sessionRow()]))
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', { listSessions })
    ).resolves.toBe('/host/transcript.jsonl')
    expect(listSessions).toHaveBeenNthCalledWith(
      2,
      { unlimited: true, force: true },
      { signal: undefined }
    )
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('returns null only after a healthy owning-host refresh also has no source', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValue(index([sessionRow({ executionHostId: 'ssh:foreign' })]))
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', { listSessions })
    ).resolves.toBeNull()
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('does not refresh or fall back when the owning host index is unavailable', async () => {
    const listSessions = vi.fn().mockRejectedValue(new Error('sidecar unavailable'))
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', { listSessions })
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_SOURCE_INDEX_UNAVAILABLE' })
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('does not retry a partial provider index', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValue(
        index([], [{ agent: 'codex', path: '/host', message: 'permission denied' }])
      )
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', { listSessions })
    ).rejects.toThrow(/index unavailable/)
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation before scanning and after an uncooperative service replies', async () => {
    const controller = new AbortController()
    const listSessions = vi.fn().mockImplementation(async () => {
      controller.abort()
      return index([sessionRow()])
    })
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', {
        listSessions,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', {
        listSessions,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('preserves service cancellation', async () => {
    const error = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const listSessions = vi.fn().mockRejectedValue(error)
    await expect(
      resolveIndexedTranscriptFilePath('codex', 'wanted', { listSessions })
    ).rejects.toBe(error)
  })
})

describe('validateIndexedTranscriptIdentity', () => {
  it.each([undefined, '', ' wanted', 'wanted ', 'bad\nidentity', 'x'.repeat(513)])(
    'rejects invalid or inexact session IDs',
    (sessionId) => {
      expect(() => validateIndexedTranscriptIdentity('codex', sessionId)).toThrow(
        /Invalid transcript source session ID/
      )
    }
  )

  it.each([undefined, 'unregistered-agent', 'Codex', ' codex'])(
    'rejects unknown agents',
    (agent) => {
      expect(() => validateIndexedTranscriptIdentity(agent, 'wanted')).toThrow(
        /Invalid transcript source agent/
      )
    }
  )
})

function index(
  sessions: AiVaultSession[] = [],
  issues: AiVaultListResult['issues'] = []
): AiVaultListResult {
  return { sessions, issues, scannedAt: '2026-09-12T00:00:00.000Z' }
}

function sessionRow(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'codex:wanted',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'wanted',
    title: 'Session title',
    cwd: '/host/project',
    branch: null,
    model: null,
    filePath: '/host/transcript.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-12T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'Preview must never be used', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}
