import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { countProtectedCredentialSites } from './transcript-protected-credentials'

const read = vi.hoisted(() => vi.fn())
vi.mock('../native-chat/transcript-watch', () => ({ readNativeChatTranscriptTail: read }))
const { buildSessionTranscript } = await import('./session-transcript-deliverable')

function message(
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id: 'm', role, blocks, timestamp: 0, source: 'transcript' } as NativeChatMessage
}

describe('labeled credentials', () => {
  it('withholds the reviewer payload: a password in a tool input', async () => {
    read.mockResolvedValue({
      messages: [
        message([
          {
            type: 'tool-call',
            name: 'Write',
            input: { path: '/tmp/x.json', password: 'synthetic-review-password-4829' }
          }
        ])
      ],
      hasMore: false,
      beforeOffset: 0
    })
    const built = await buildSessionTranscript({
      agent: 'claude',
      sessionId: 'ses-1',
      capturedAt: '2026-09-13T10:00:00.000Z',
      limit: 100
    })
    expect(built).toEqual({ kind: 'refused', redactions: 1 })
  })

  it('finds protected keys nested in structures, case-insensitively', () => {
    expect(
      countProtectedCredentialSites([
        message([
          {
            type: 'tool-call',
            name: 'Bash',
            input: {
              env: { API_KEY: 'k', nested: [{ Refresh_Token: 'r' }] },
              headers: { Authorization: 'Bearer x', cookie: 'a=b' },
              empty: { password: '' }
            }
          }
        ])
      ])
    ).toBe(4)
  })

  it('finds quoted and bare assignments in text and tool output', () => {
    expect(
      countProtectedCredentialSites([
        message([{ type: 'text', text: 'config: "password": "hunter22" and token: abcd1234' }]),
        message([
          {
            type: 'tool-result',
            output: `export CLIENT_SECRET='zzz-secret-1' ; api_key="q1w2e3r4"`
          }
        ])
      ])
    ).toBe(4)
  })

  it('leaves ordinary prose about the words alone', () => {
    expect(
      countProtectedCredentialSites([
        message([{ type: 'text', text: 'Reset the password field, then rotate the token later.' }]),
        message([{ type: 'tool-call', name: 'Read', input: { path: '/etc/passwd' } }])
      ])
    ).toBe(0)
  })

  it('withholds key FAMILIES: database_password, OPENAI_API_KEY, a bearer header in a tool result', async () => {
    const cases: NativeChatMessage[][] = [
      [message([{ type: 'tool-call', name: 'Write', input: { database_password: 'pg-4829' } }])],
      [message([{ type: 'tool-call', name: 'Bash', input: { env: { OPENAI_API_KEY: 'sk-x' } } }])],
      [message([{ type: 'tool-call', name: 'Bash', input: { stripe_secret_key: 'sk_live_1' } }])],
      [message([{ type: 'tool-result', output: 'Authorization: Bearer eyJhbGciOi' }])],
      [message([{ type: 'text', text: '"OPENAI_API_KEY": "sk-proj-abc"' }])],
      [message([{ type: 'tool-result', output: 'DATABASE_PASSWORD=pg-4829' }])]
    ]
    for (const messages of cases) {
      read.mockResolvedValue({ messages, hasMore: false, beforeOffset: 0 })
      const built = await buildSessionTranscript({
        agent: 'claude',
        sessionId: 'ses-1',
        capturedAt: '2026-09-13T10:00:00.000Z',
        limit: 100
      })
      expect(built, JSON.stringify(messages)).toEqual({ kind: 'refused', redactions: 1 })
    }
  })

  it('does not mistake an author or a session id for a credential', () => {
    expect(
      countProtectedCredentialSites([
        message([
          {
            type: 'tool-call',
            name: 'mcp__omni__attach',
            input: { author: 'sal', session_id: 'ses_abc123', coauthor: 'uma' }
          }
        ])
      ])
    ).toBe(0)
  })

  it('uploads whole tool payloads: a 5,000-character tool result keeps its tail', async () => {
    const output = `${'x'.repeat(4_990)}TAIL-END`
    read.mockResolvedValue({
      messages: [message([{ type: 'tool-result', output }])],
      hasMore: false,
      beforeOffset: 0
    })
    const source = {
      agent: 'claude',
      sessionId: 'ses-1',
      capturedAt: '2026-09-13T10:00:00.000Z',
      limit: 100
    }
    const upload = await buildSessionTranscript({ ...source, clipToolPayloads: false })
    expect(upload.kind).toBe('built')
    if (upload.kind === 'built') {
      expect(upload.deliverable.bytes.toString('utf8')).toContain('TAIL-END')
      expect(upload.deliverable.truncatedBlocks).toBe(0)
    }
    const handoff = await buildSessionTranscript(source)
    expect(handoff.kind).toBe('built')
    if (handoff.kind === 'built') {
      expect(handoff.deliverable.bytes.toString('utf8')).not.toContain('TAIL-END')
      expect(handoff.deliverable.truncatedBlocks).toBe(1)
    }
  })
})
