import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseCodexRolloutTurnFailure,
  readCodexRolloutTurnFailure
} from './codex-rollout-turn-failure'

const USAGE_WALL =
  'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:04 PM.'

function codexRolloutLines(
  error: { message: string; codex_error_info?: unknown } | null,
  at = '2026-10-01T12:00:05.000Z'
): string {
  return [
    {
      timestamp: '2026-10-01T12:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' }
    },
    {
      timestamp: '2026-10-01T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ text: 'Finish the edit.' }]
      }
    },
    {
      timestamp: '2026-10-01T12:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 100 } }
      }
    },
    {
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: null,
        ...(error ? { error } : {})
      }
    }
  ]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join('')
}

describe('Codex rollout turn failure', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the usage wall Codex recorded on the turn it ended', () => {
    expect(
      parseCodexRolloutTurnFailure(
        codexRolloutLines({
          message: USAGE_WALL,
          codex_error_info: 'usage_limit_exceeded'
        })
      )
    ).toEqual({
      failedAt: Date.parse('2026-10-01T12:00:05.000Z'),
      reason: USAGE_WALL,
      usageLimit: true
    })
  })

  it('treats spend caps and credit walls Codex classified as usage limits', () => {
    expect(
      parseCodexRolloutTurnFailure(
        codexRolloutLines({
          message:
            'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
          codex_error_info: 'usage_limit_exceeded'
        })
      )?.usageLimit
    ).toBe(true)
  })

  it('does not treat a transient 429, an auth failure or an unclassified error as a usage wall', () => {
    for (const codex_error_info of ['rate_limit_exceeded', 'unauthorized', 'server_overloaded']) {
      expect(
        parseCodexRolloutTurnFailure(
          codexRolloutLines({
            message: 'Rate limit reached; retrying.',
            codex_error_info
          })
        )?.usageLimit
      ).toBe(false)
    }
    expect(
      parseCodexRolloutTurnFailure(codexRolloutLines({ message: 'stream disconnected' }))
        ?.usageLimit
    ).toBe(false)
    // Older error records without a classification fall back to the shared usage-wall wording.
    expect(
      parseCodexRolloutTurnFailure(codexRolloutLines({ message: USAGE_WALL }))?.usageLimit
    ).toBe(true)
  })

  it('ignores successful turns and any turn started after the failure', () => {
    expect(parseCodexRolloutTurnFailure(codexRolloutLines(null))).toBeNull()
    const failed = codexRolloutLines({
      message: USAGE_WALL,
      codex_error_info: 'usage_limit_exceeded'
    })
    const next = `${JSON.stringify({ timestamp: '2026-10-01T12:01:00.000Z', type: 'event_msg', payload: { type: 'task_started' } })}\n`
    expect(parseCodexRolloutTurnFailure(failed + next)).toBeNull()
    const steering = `${JSON.stringify({ timestamp: '2026-10-01T12:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user' } })}\n`
    expect(parseCodexRolloutTurnFailure(failed + steering)).toBeNull()
    // A record still being written may be the next turn.
    expect(parseCodexRolloutTurnFailure(`${failed}{"type":"event_msg"`)).toBeNull()
  })

  it('rereads the rollout only when it changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-rollout-'))
    dirs.push(dir)
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(
      path,
      codexRolloutLines({
        message: USAGE_WALL,
        codex_error_info: 'usage_limit_exceeded'
      })
    )
    expect(readCodexRolloutTurnFailure(path)?.usageLimit).toBe(true)
    appendFileSync(
      path,
      `${JSON.stringify({ timestamp: '2026-10-01T12:09:00.000Z', type: 'event_msg', payload: { type: 'task_started' } })}\n`
    )
    expect(readCodexRolloutTurnFailure(path)).toBeNull()
    expect(readCodexRolloutTurnFailure(join(dir, 'missing.jsonl'))).toBeNull()
  })
})
