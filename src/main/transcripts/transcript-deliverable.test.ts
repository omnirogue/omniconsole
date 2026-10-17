import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildTranscriptDeliverable,
  countPemOpenings,
  transcriptFileName,
  TranscriptDeliverableError,
  TRANSCRIPT_PROTECTED_DATA_CODE,
  type TranscriptCapture
} from './transcript-deliverable'
import { journalTruncationMarker } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { transcriptTruncationMarker } from '../../shared/transcript-render'
import { redactString } from '../observability/redactor'
import type { NativeChatMessage } from '../../shared/native-chat-types'

function capture(messages: NativeChatMessage[]): TranscriptCapture {
  return {
    messages,
    agent: 'claude',
    model: 'opus-5',
    sessionId: 'ses_abc123',
    capturedAt: '2026-09-13T09:30:00.000Z',
    sourceDigest: 'b'.repeat(64)
  }
}

function said(text: string, id = 'm1'): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
    source: 'transcript'
  }
}

describe('buildTranscriptDeliverable', () => {
  it('returns the file bytes with a name, digest and size for a clean transcript', () => {
    const result = buildTranscriptDeliverable(capture([said('Ship the thing.')]))
    expect(result.name).toBe('transcript-ses_abc123-20260913.md')
    expect(result.size).toBe(result.bytes.byteLength)
    expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'))
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.redactions).toBe(0)
    expect(result.messageCount).toBe(1)
    expect(result.bytes.toString('utf8')).toContain('Ship the thing.')
  })

  it('refuses a transcript carrying a provider key instead of scrubbing it', () => {
    const key = `sk-ant-${'a'.repeat(50)}`
    expect(() => buildTranscriptDeliverable(capture([said(`the key is ${key}`)]))).toThrow(
      TranscriptDeliverableError
    )
    try {
      buildTranscriptDeliverable(capture([said(`the key is ${key}`)]))
      expect.unreachable('the transcript should have been refused')
    } catch (error) {
      const refusal = error as TranscriptDeliverableError
      expect(refusal.code).toBe(TRANSCRIPT_PROTECTED_DATA_CODE)
      expect(refusal.redactions).toBe(1)
      expect(refusal.message).toContain(TRANSCRIPT_PROTECTED_DATA_CODE)
      // The refusal never echoes the value it refused.
      expect(refusal.message).not.toContain(key)
    }
  })

  it('counts every protected value it found', () => {
    const messages = [
      said(`first sk-ant-${'a'.repeat(50)}`, 'm1'),
      said(`second AKIA${'B'.repeat(16)}`, 'm2'),
      said('third password: hunter2', 'm3')
    ]
    try {
      buildTranscriptDeliverable(capture(messages))
      expect.unreachable('the transcript should have been refused')
    } catch (error) {
      expect((error as TranscriptDeliverableError).redactions).toBe(3)
    }
  })

  it('refuses a secret hidden in tool output, not only in prose', () => {
    const message: NativeChatMessage = {
      id: 'm1',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: `GITHUB_TOKEN=ghp_${'c'.repeat(36)}` }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
    expect(() => buildTranscriptDeliverable(capture([message]))).toThrow(TranscriptDeliverableError)
  })

  it('refuses a PEM whose END line the tool-output clip would have removed', () => {
    // The reviewer's case: 4 KiB clipping drops `-----END PRIVATE KEY-----`, so
    // a document-only scan would no longer match a key the file still carries.
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(5000)}\n-----END PRIVATE KEY-----`
    const message: NativeChatMessage = {
      id: 'm1',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: pem }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
    expect(() => buildTranscriptDeliverable(capture([message]))).toThrow(TranscriptDeliverableError)
  })

  it('proves the clipped document alone would not have caught that PEM', () => {
    // Guards the reason gate 1 exists: if this ever starts matching, the
    // pre-clip scan is still correct but this test no longer proves why.
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(5000)}\n-----END PRIVATE KEY-----`
    const clipped = pem.slice(0, 4096)
    expect(redactString(clipped)).toBe(clipped)
  })

  it('refuses a PEM in a tool call input too', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'B'.repeat(5000)}\n-----END RSA PRIVATE KEY-----`
    const message: NativeChatMessage = {
      id: 'm1',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'write_file', input: { body: pem } }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
    expect(() => buildTranscriptDeliverable(capture([message]))).toThrow(TranscriptDeliverableError)
  })

  it('discloses records the reader skipped, in the header and the footer', () => {
    const result = buildTranscriptDeliverable({
      ...capture([said('first'), said('third', 'm3')]),
      omittedRecords: 1
    })
    const body = result.bytes.toString('utf8')
    expect(body).toContain('- Omitted records: 1')
    expect(body).toContain('missing from the middle of this transcript')
    expect(body).toContain('not a continuous record of the session')
  })

  it('sends a transcript that merely discusses redaction markers', () => {
    const result = buildTranscriptDeliverable(capture([said('we print [redacted:anthropic-key]')]))
    expect(result.redactions).toBe(0)
    expect(result.bytes.toString('utf8')).toContain('[redacted:anthropic-key]')
  })

  it('keeps the session identity in a legal file name', () => {
    expect(transcriptFileName('ses/../abc', '2026-01-02T00:00:00.000Z')).toBe(
      'transcript-ses-abc-20260102.md'
    )
    expect(transcriptFileName('', '2026-01-02T00:00:00.000Z')).toBe(
      'transcript-session-20260102.md'
    )
  })

  it('refuses a capture with no valid captured-at time', () => {
    expect(() =>
      buildTranscriptDeliverable({ ...capture([said('hi')]), capturedAt: 'soon' })
    ).toThrow(/valid captured-at/)
  })

  it('passes the size bound through, naming the size it refused', () => {
    expect(() => buildTranscriptDeliverable(capture([said('z'.repeat(4000))]), 1024)).toThrow(
      /above the 1024 byte limit/
    )
  })

  it('uses one truncation wording with the agent session journal', () => {
    expect(transcriptTruncationMarker(4096, 'a'.repeat(64))).toBe(
      journalTruncationMarker(4096, 'a'.repeat(64))
    )
  })
})

describe('a key split across payloads', () => {
  function toolResult(output: string, id: string): NativeChatMessage {
    return {
      id,
      role: 'tool',
      blocks: [{ type: 'tool-result', output }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
  }

  it('refuses a PEM whose BEGIN and END sit in two different tool results', () => {
    // The reviewer's case: neither payload matches alone, and by the time they
    // meet in the document the 4 KiB clip has removed the END line.
    const first = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(500)}`
    const second = `${'A'.repeat(4500)}\n-----END PRIVATE KEY-----`
    expect(() =>
      buildTranscriptDeliverable(capture([toolResult(first, 'm1'), toolResult(second, 'm2')]))
    ).toThrow(TranscriptDeliverableError)
  })

  it('proves neither half matches on its own', () => {
    // Guards the reason the combined gate exists.
    const first = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(500)}`
    const second = `${'A'.repeat(4500)}\n-----END PRIVATE KEY-----`
    expect(redactString(first)).toBe(first)
    expect(redactString(second)).toBe(second)
  })

  it('refuses a PEM split across three tool results', () => {
    const parts = [
      `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(400)}`,
      'A'.repeat(4000),
      `${'A'.repeat(400)}\n-----END PRIVATE KEY-----`
    ]
    expect(() =>
      buildTranscriptDeliverable(
        capture(parts.map((part, index) => toolResult(part, `m${index + 1}`)))
      )
    ).toThrow(TranscriptDeliverableError)
  })

  it('refuses a key split across a tool result and an assistant message', () => {
    const message: NativeChatMessage = {
      id: 'm2',
      role: 'assistant',
      blocks: [{ type: 'text', text: `${'A'.repeat(4500)}\n-----END PRIVATE KEY-----` }],
      timestamp: Date.UTC(2026, 8, 13, 9, 1, 0),
      source: 'transcript'
    }
    expect(() =>
      buildTranscriptDeliverable(
        capture([toolResult(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(500)}`, 'm1'), message])
      )
    ).toThrow(TranscriptDeliverableError)
  })

  it('still sends an ordinary conversation that spans many messages', () => {
    const result = buildTranscriptDeliverable(
      capture([said('first', 'm1'), said('second', 'm2'), said('third', 'm3')])
    )
    expect(result.redactions).toBe(0)
    expect(result.messageCount).toBe(3)
  })
})

describe('the joined pre-clip gate', () => {
  function toolResult(output: string, id: string): NativeChatMessage {
    return {
      id,
      role: 'tool',
      blocks: [{ type: 'tool-result', output }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
  }

  it('refuses a PEM whose END delimiter is itself split across outputs', () => {
    // The reviewer's case: any separator between payloads would leave
    // `-----END PRIVATE` + `<sep>` + ` KEY-----`, which matches nothing, and
    // 4,596 bytes of key body would ship.
    const parts = [
      `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(500)}`,
      `${'A'.repeat(4500)}\n-----END PRIVATE`,
      ' KEY-----'
    ]
    expect(() =>
      buildTranscriptDeliverable(
        capture(parts.map((part, index) => toolResult(part, `m${index + 1}`)))
      )
    ).toThrow(TranscriptDeliverableError)
  })

  it('refuses an opening whose close never arrives at all', () => {
    // A PEM prefix with no end is the clipping case: body present, delimiter
    // cut. It is refused on sight rather than waited on.
    expect(() =>
      buildTranscriptDeliverable(
        capture([toolResult(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(5000)}`, 'm1')])
      )
    ).toThrow(TranscriptDeliverableError)
  })

  it('refuses a provider key split across two outputs', () => {
    // The single-line families straddle a boundary too, and with no separator
    // the two halves are adjacent.
    expect(() =>
      buildTranscriptDeliverable(
        capture([toolResult(`sk-ant-${'a'.repeat(20)}`, 'm1'), toolResult('b'.repeat(40), 'm2')])
      )
    ).toThrow(TranscriptDeliverableError)
  })

  it('still sends a benign transcript whose payloads simply abut', () => {
    const result = buildTranscriptDeliverable(
      capture([toolResult('ordinary output', 'm1'), toolResult('more output', 'm2')])
    )
    expect(result.redactions).toBe(0)
  })
})

describe('countPemOpenings', () => {
  it('counts matched and unmatched openings alike', () => {
    expect(countPemOpenings('nothing here')).toBe(0)
    expect(countPemOpenings('-----BEGIN X-----body-----END X-----')).toBe(1)
    expect(countPemOpenings('-----BEGIN X-----body')).toBe(1)
    expect(
      countPemOpenings('-----BEGIN A-----b-----END A----- and -----BEGIN B-----c-----END B-----')
    ).toBe(2)
  })

  it('treats an opening with no close as one span running to the end', () => {
    // Nothing after an unmatched opening can be outside it, so the scan stops.
    // One opening is all a refusal needs.
    expect(countPemOpenings('-----BEGIN PRIVATE KEY-----'.repeat(20_000))).toBe(1)
  })

  it('stays linear across many complete pairs', () => {
    // The shape that made the old regex quadratic, now walked once: 20,000
    // openings means 20,000 loop turns, each an indexOf that only moves on.
    const text = `-----BEGIN X-----${'b'.repeat(200)}-----END X-----`.repeat(20_000)
    const started = performance.now()
    expect(countPemOpenings(text)).toBe(20_000)
    expect(performance.now() - started).toBeLessThan(200)
  })

  it('stays linear on 5 MB of text holding no opening at all', () => {
    const started = performance.now()
    expect(countPemOpenings('x'.repeat(5 * 1024 * 1024))).toBe(0)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('build cost on a large benign transcript', () => {
  it('scans 5 MB of ordinary messages in linear time', () => {
    // 5,000 messages of ~1 KB. The reviewer measured a 4.44 MB benign build at
    // 931 ms against the quadratic joined regex; the linear scan must not be
    // anywhere near that.
    const messages: NativeChatMessage[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `m${index}`,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: `ordinary assistant prose ${'x'.repeat(1000)}` }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript' as const
    }))
    const started = performance.now()
    const result = buildTranscriptDeliverable(capture(messages), 64 * 1024 * 1024)
    const elapsed = performance.now() - started
    expect(result.messageCount).toBe(5000)
    expect(result.size).toBeGreaterThan(5_000_000)
    expect(elapsed).toBeLessThan(2000)
  })

  it('does not degrade when those messages each carry an unmatched opening', () => {
    // Same size, but every message holds a BEGIN with no END — the quadratic
    // trigger. This must refuse, and refuse fast.
    const messages: NativeChatMessage[] = Array.from({ length: 5000 }, (_, index) => ({
      id: `m${index}`,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: `-----BEGIN PRIVATE KEY-----${'A'.repeat(1000)}` }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript' as const
    }))
    const started = performance.now()
    expect(() => buildTranscriptDeliverable(capture(messages), 64 * 1024 * 1024)).toThrow(
      TranscriptDeliverableError
    )
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('a single payload full of openings', () => {
  it('refuses 1.4 MB of repeated BEGIN lines without a regex pass', () => {
    // The reviewer's case: this fits the reader's 2 MiB record limit, and
    // running redactString on the payload first took 3,441 ms. Nothing may
    // reach a regex before the linear scan has refused it.
    const output = '-----BEGIN PRIVATE KEY-----\n'.repeat(Math.ceil((1.4 * 1024 * 1024) / 28))
    expect(output.length).toBeGreaterThan(1.4 * 1024 * 1024)
    const message: NativeChatMessage = {
      id: 'm1',
      role: 'tool',
      blocks: [{ type: 'tool-result', output }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
    const started = performance.now()
    expect(() => buildTranscriptDeliverable(capture([message]))).toThrow(TranscriptDeliverableError)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('refuses 2.8 MB of them just as fast', () => {
    const output = '-----BEGIN PRIVATE KEY-----\n'.repeat(Math.ceil((2.8 * 1024 * 1024) / 28))
    const message: NativeChatMessage = {
      id: 'm1',
      role: 'tool',
      blocks: [{ type: 'tool-result', output }],
      timestamp: Date.UTC(2026, 8, 13, 9, 0, 0),
      source: 'transcript'
    }
    const started = performance.now()
    expect(() => buildTranscriptDeliverable(capture([message]))).toThrow(TranscriptDeliverableError)
    expect(performance.now() - started).toBeLessThan(100)
  })
})
