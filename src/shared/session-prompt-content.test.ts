import { describe, expect, it } from 'vitest'
import { isWeakTitlePrompt } from './session-prompt-content'

describe('isWeakTitlePrompt', () => {
  it('flags a prompt that opens with a paste, a CLI banner or log output', () => {
    for (const prompt of [
      '[Pasted text #1 +40 lines] fix this',
      '[Pasted content id:9fa8] Claude Code v2.1.282',
      '[Image #1]',
      '▐▛███▜▌ Claude Code v2.1.282\n▝▜█████▛▘ Fable 5.1 · API usage',
      '╭───────────────╮\n│ ✻ Welcome │',
      'Claude Code v2.1.282 Fable 5.1',
      '2026-09-27T10:00:01Z INFO server started',
      '$ pnpm build\n> tsc',
      'Traceback (most recent call last):\n  File "x.py"',
      '{"a": 1, "b": [2, 3], "c": 4}'
    ]) {
      expect(isWeakTitlePrompt(prompt), prompt).toBe(true)
    }
  })

  it('keeps an ordinary ask, even one that mentions a box character later', () => {
    for (const prompt of [
      'Fix the session titles so they use relevant context',
      'Why does the table border render as ─ in the sidebar?',
      'Review PR #812',
      ''
    ]) {
      expect(isWeakTitlePrompt(prompt), prompt).toBe(false)
    }
  })
})
