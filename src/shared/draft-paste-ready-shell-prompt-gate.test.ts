// Compat gate: a plain shell prompt is not an agent composer. The shell that runs the
// launch command enables bracketed paste itself, so any readiness signal that fires on
// the shell's own prompt pastes a generated prompt into a shell. Grok's alt-screen
// anchoring has its own cases in draft-paste-ready-scanner.test.ts; this file pins the
// shell-prompt verdict for every signal, including the one that still accepts it.
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const SHOW_CURSOR = '\x1b[?25h'
// A shell prompt as it really arrives: bracketed paste enabled, cursor shown, prompt drawn.
const STARSHIP_PROMPT = `${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}\x1b[32m❯\x1b[0m `
const BASH_PROMPT = `${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}user@host ~/webinar $ `
const ZSH_PROMPT = `${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}webinar % `

describe('a shell prompt is not an agent ready prompt', () => {
  it.each([STARSHIP_PROMPT, BASH_PROMPT, ZSH_PROMPT])('is never a Codex composer: %j', (prompt) => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    expect(scanner.observe(prompt)).toEqual({ ready: false, armQuietTimer: false })
  })

  it.each([STARSHIP_PROMPT, BASH_PROMPT, ZSH_PROMPT])('is never a grok composer: %j', (prompt) => {
    const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
    // The quiet-window fallback may arm (it is anchored on DECSET 2004 by design), but the
    // composer marker must not fire outside grok's alternate screen.
    expect(scanner.observe(prompt).ready).toBe(false)
  })

  it.each([STARSHIP_PROMPT, BASH_PROMPT, ZSH_PROMPT])(
    'is never a marker-ready signal for the quiet-window default: %j',
    (prompt) => {
      const scanner = createDraftPasteReadyScanner('render-quiet-after-bracketed-paste')
      expect(scanner.observe(prompt)).toEqual({ ready: false, armQuietTimer: true })
    }
  )

  it('records the one signal that still accepts a shell prompt as composer-ready', () => {
    // MEASURED EXPOSURE (opencode / mimo-code): `render-cursor-after-bracketed-paste` fires
    // on DECTCEM show-cursor after DECSET 2004, and a shell prompt emits exactly that pair —
    // so the shell's own prompt reads as ready. Unlike grok's `❯`, this marker is not anchored
    // on the alternate screen. If that anchoring is fixed, tighten this expectation to false;
    // it is pinned here so the change is a deliberate, visible one.
    const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
    expect(scanner.observe(BASH_PROMPT)).toEqual({ ready: true, armQuietTimer: false })
  })

  it('accepts the real composer signal that follows the shell prompt', () => {
    // The positive half: once Codex renders its own composer glyph, readiness fires.
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    expect(scanner.observe(BASH_PROMPT).ready).toBe(false)
    expect(scanner.observe('\x1b[1m›\x1b[0m Ask Codex to do anything').ready).toBe(true)
  })
})
