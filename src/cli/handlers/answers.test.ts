import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANSWER_DELIVERY_PILOT_FILE } from '../../shared/answer-delivery-pilot-report'
import { answerPilotReport, formatAnswerPilotReport } from './answers'

const now = Date.parse('2026-10-17T21:00:00Z')

function record(id: string, claimedAt: string, outcome = 'confirmed') {
  return JSON.stringify({
    key: `review:p:${id}`,
    id,
    conversation: 'claude:c',
    path: outcome === 'confirmed' ? 'hook_prompt' : null,
    claimedAt,
    injectedAt: claimedAt,
    confirmedAt:
      outcome === 'confirmed' ? new Date(Date.parse(claimedAt) + 30_000).toISOString() : null,
    fallbackAt: null,
    ackAt: null,
    attempts: 1,
    outcome
  })
}

describe('omni answers pilot-report', () => {
  it('reads the JSONL and its rotated copy for the --since window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-pilot-'))
    const file = join(dir, ANSWER_DELIVERY_PILOT_FILE)
    writeFileSync(`${file}.1`, `${record('old', '2026-10-15T21:00:00Z')}\n`)
    writeFileSync(
      file,
      `${record('a', '2026-10-17T20:30:00Z')}\n${record('b', '2026-10-17T20:40:00Z', 'open')}\n`
    )
    const day = answerPilotReport(new Map(), dir, now)
    expect(day).toMatchObject({ deliveries: 2, open: 1, byPath: { hook_prompt: 1 } })
    const week = answerPilotReport(new Map([['since', '7d']]), dir, now)
    expect(week.deliveries).toBe(3)
    expect(formatAnswerPilotReport(day)).toContain('p50 30 s')
  })

  it('refuses a --since it cannot read and works with no file at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-pilot-'))
    expect(() => answerPilotReport(new Map([['since', 'yesterday']]), dir, now)).toThrow('--since')
    expect(answerPilotReport(new Map(), dir, now).deliveries).toBe(0)
  })
})
