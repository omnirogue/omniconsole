import { describe, expect, it } from 'vitest'
import {
  formatSessionReference,
  parseSessionReference,
  rowsForSessionReference,
  sessionReferenceForRow,
  transcriptSessionIdOf
} from './session-reference'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'

describe('session references', () => {
  it('round-trips agent, id and host, host normalized', () => {
    const ref = formatSessionReference({ agent: 'claude', sessionId: ID, hostId: 'local' })
    expect(ref).toBe(`claude:${ID}@local`)
    expect(parseSessionReference(ref)).toEqual({ agent: 'claude', sessionId: ID, hostId: 'local' })
    expect(parseSessionReference(`codex:${ID}@runtime:env-1`)).toEqual({
      agent: 'codex',
      sessionId: ID,
      hostId: 'runtime:env-1'
    })
  })

  it('refuses anything that is not a Claude or Codex conversation on a named host', () => {
    expect(parseSessionReference(`gemini:${ID}@local`)).toBeNull()
    expect(parseSessionReference(`claude:${ID}`)).toBeNull()
    expect(parseSessionReference(`claude:${ID}@nowhere`)).toBeNull()
    expect(parseSessionReference('claude:../etc@local')).toBeNull()
    expect(parseSessionReference('claude:-rf@local')).toBeNull()
  })

  it('names a transcript by its file, and a Codex rollout by its UUID tail', () => {
    expect(transcriptSessionIdOf(`/h/.claude/projects/-w/${ID}.jsonl`)).toBe(ID)
    expect(
      transcriptSessionIdOf(`/h/.codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-${ID}.jsonl`)
    ).toBe(ID)
    expect(transcriptSessionIdOf('C:\\u\\.claude\\projects\\w\\abc.jsonl')).toBe('abc')
  })

  it('finds every row holding the conversation on the same host, by id or transcript name', () => {
    const rows = [
      { name: 'hook-id', hostId: 'local', providerSessionId: ID, transcriptPath: null },
      {
        name: 'file-name',
        hostId: 'local',
        providerSessionId: 'other-hook-id',
        transcriptPath: `/p/${ID}.jsonl`
      },
      { name: 'other-host', hostId: 'runtime:env-1', providerSessionId: ID },
      { name: 'unknown-host', hostId: null, providerSessionId: ID },
      { name: 'unrelated', hostId: 'local', providerSessionId: 'x' }
    ]
    expect(
      rowsForSessionReference({ sessionId: ID.toUpperCase(), hostId: 'local' }, rows).map(
        (row) => row.name
      )
    ).toEqual(['hook-id', 'file-name'])
    expect(
      rowsForSessionReference(
        { sessionId: 'not-the-name', hostId: 'local', transcriptPath: '/p/x.jsonl' },
        [{ hostId: 'local', transcriptPath: '/p/x.jsonl' }]
      )
    ).toHaveLength(1)
  })

  it('gives a row its own ref only when its agent reported a Claude or Codex conversation', () => {
    expect(
      sessionReferenceForRow({
        hostId: 'local',
        agent: 'claude',
        providerSessionId: 'hook-id',
        transcriptPath: `/p/${ID}.jsonl`
      })
    ).toBe(`claude:${ID}@local`)
    expect(sessionReferenceForRow({ hostId: 'local', agent: 'codex', providerSessionId: ID })).toBe(
      `codex:${ID}@local`
    )
    expect(
      sessionReferenceForRow({ hostId: 'local', agent: 'gemini', providerSessionId: ID })
    ).toBeNull()
    expect(
      sessionReferenceForRow({ hostId: null, agent: 'claude', providerSessionId: ID })
    ).toBeNull()
    expect(sessionReferenceForRow({ hostId: 'local', agent: 'claude' })).toBeNull()
  })
})
