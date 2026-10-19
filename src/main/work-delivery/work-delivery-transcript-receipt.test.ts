import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deliveryFingerprint,
  findDeliveryInTranscripts,
  readTranscriptTail,
  userTurnText
} from './work-delivery-transcript-receipt'

const SLUG = '1a1463cfb969aad9b'
const TEXT = `[OmniOS decision] Sal approved “Launch plan” (https://app.omnisi.ai/a/${SLUG}). Comment: ship it on Monday.`
const DELIVERY = { text: TEXT, eventAt: '2026-10-16T20:00:00Z', createdAt: null }

const at = (minute: number) => `2026-10-16T20:${String(minute).padStart(2, '0')}:00Z`
const claudeUser = (text: string, ts = at(1)) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const claudeAssistant = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(1),
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
const claudeToolUse = (id: string, command: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(1),
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }
  })
const claudeToolResult = (id: string, text: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(2),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
  })

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wd-receipt-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
function write(name: string, lines: string[]): string {
  const path = join(dir, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/** The publishing session's own transcript: it waited on the page, but nothing was delivered. */
function publisherLines(): string[] {
  const lines = [claudeUser('Publish the launch plan for Sal and wait for his decision.', at(0))]
  for (let i = 0; i < 20; i++) {
    lines.push(claudeToolUse(`w${i}`, `~/Work/Ops/bin/work-decision wait ${SLUG}`))
    lines.push(claudeToolResult(`w${i}`, `[choices] ${SLUG} still pending`))
  }
  lines.push(claudeAssistant(`Waiting on https://app.omnisi.ai/a/${SLUG} (work-decision wait).`))
  lines.push(
    JSON.stringify({
      type: 'attachment',
      timestamp: at(3),
      content: `<peer-message from="choices">${SLUG} decided</peer-message>`
    })
  )
  // The decision text itself, but only as tool output and assistant text.
  lines.push(claudeToolUse('s1', `omni artifacts status ${SLUG} --json`))
  lines.push(claudeToolResult('s1', TEXT))
  lines.push(claudeAssistant(`The page says: ${TEXT}`))
  return lines
}

describe('findDeliveryInTranscripts', () => {
  it('never takes the publisher’s wait markers, tool output or assistant echo for a delivery', async () => {
    const path = write('publisher.jsonl', publisherLines())
    expect(await findDeliveryInTranscripts([path], DELIVERY)).toBeNull()
  })

  it('confirms the delivered text as a user turn after the event', async () => {
    const path = write('delivered.jsonl', [...publisherLines(), claudeUser(TEXT, at(5))])
    expect(await findDeliveryInTranscripts([path], DELIVERY)).toContain('delivered.jsonl')
  })

  it('matches across terminal whitespace changes', async () => {
    const path = write('wrapped.jsonl', [claudeUser(TEXT.replace(/ /g, '\n  '), at(5))])
    expect(await findDeliveryInTranscripts([path], DELIVERY)).not.toBeNull()
  })

  it('ignores the same text typed well before the event, and undated turns', async () => {
    const early = write('early.jsonl', [claudeUser(TEXT, '2026-10-16T19:00:00Z')])
    const undated = write('undated.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: TEXT } })
    ])
    expect(await findDeliveryInTranscripts([early, undated], DELIVERY)).toBeNull()
  })

  it('reads Codex user messages', async () => {
    const path = write('codex.jsonl', [
      JSON.stringify({
        type: 'response_item',
        timestamp: at(4),
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: TEXT }] }
      })
    ])
    expect(await findDeliveryInTranscripts([path], DELIVERY)).not.toBeNull()
  })

  it('proves nothing for a text too short to be this decision', async () => {
    const path = write('short.jsonl', [claudeUser('Approved', at(5))])
    expect(deliveryFingerprint('Approved')).toBeNull()
    expect(await findDeliveryInTranscripts([path], { ...DELIVERY, text: 'Approved' })).toBeNull()
  })

  it('reads only the tail of each transcript and at most maxFiles of them', async () => {
    const padding = Array.from({ length: 200 }, (_, i) =>
      claudeAssistant(`line ${i} ${'x'.repeat(200)}`)
    )
    const old = write('old.jsonl', [claudeUser(TEXT, at(5)), ...padding])
    expect(
      await findDeliveryInTranscripts([old], DELIVERY, { tailBytes: 4096, maxFiles: 2 })
    ).toBeNull()
    expect(
      await findDeliveryInTranscripts([old], DELIVERY, { tailBytes: 1024 * 1024, maxFiles: 2 })
    ).not.toBeNull()
    const empty = write('empty.jsonl', [claudeAssistant('nothing')])
    const third = write('third.jsonl', [claudeUser(TEXT, at(5))])
    expect(
      await findDeliveryInTranscripts([empty, empty, third], DELIVERY, {
        tailBytes: 4096,
        maxFiles: 2
      })
    ).toBeNull()
  })
})

describe('readTranscriptTail', () => {
  it('starts at the first whole line of the window', async () => {
    const path = write('tail.jsonl', ['a'.repeat(50), 'second', 'third'])
    expect(await readTranscriptTail(path, 8)).toBe('third\n')
    expect(await readTranscriptTail(path, 10_000)).toContain('a'.repeat(50))
  })
})

describe('userTurnText', () => {
  it('skips meta and compact-summary user lines', () => {
    const meta = JSON.stringify({
      type: 'user',
      isMeta: true,
      timestamp: at(1),
      message: { content: TEXT }
    })
    const summary = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      timestamp: at(1),
      message: { content: TEXT }
    })
    expect(userTurnText(meta)).toBeNull()
    expect(userTurnText(summary)).toBeNull()
    expect(userTurnText(claudeUser(TEXT))?.text).toBe(TEXT)
  })
})
