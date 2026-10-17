import { describe, expect, it } from 'vitest'
import { detectAgentStartupIntervention } from './agent-startup-intervention'

// Captured 2026-09-13 from Codex 0.153.0 on laptop (the audited update menu).
const CODEX_UPDATE_MENU = [
  '╭─────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.153.0)              │',
  '│ model:       loading   /model to change │',
  '│ permissions: YOLO mode                  │',
  '╰─────────────────────────────────────────╯',
  '  › Ask Codex to do anything   ? for shortcuts',
  '  ✨ Update available!',
  '  0.153.0 -> 0.154.0',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '  › 1. Update now (runs `npm install -g @openai/codex`)',
  '    2. Skip',
  '    3. Skip until next version',
  '  Press enter to continue'
].join('\r\n')

const CODEX_TRUST = [
  '> You are in /private/tmp/untrusted-dir2',
  'Do you trust the contents of this directory?',
  'Working with untrusted contents comes with higher risk of prompt injection.',
  '› 1. Yes, continue',
  '  2. No, quit',
  'Press enter to continue'
].join('\r\n')

const CLAUDE_TRUST = [
  'Accessing workspace:',
  '/private/tmp/untrusted-claude',
  'Quick safety check: Is this a project you created or one you trust?',
  "Claude Code'll be able to read, edit, and execute files here.",
  '❯ No, exit',
  '  Yes, I trust this folder',
  'Enter to confirm · Esc to cancel'
].join('\r\n')

const CLAUDE_ONBOARDING = [
  'Welcome to Claude Code v2.1.269',
  "Let's get started.",
  'Choose the text style that looks best with your terminal',
  '1. Auto (match terminal)',
  '❯ 2. Dark mode ✔'
].join('\r\n')

const CLAUDE_ONBOARDING_SERIALIZED =
  'Let\'sgetstarted.\nChoosethetextstylethatlooksbestwithyourterminal\nTochangethislater,run/theme\n1.Auto(matchterminal)\n\u276f2.Darkmode\u2714\n3.Lightmode\n4.Darkmode(colorblind-friendly)\n5.Lightmode(colorblind-friendly)\n6.Darkmode(ANSIcolorsonly)\n7.Lightmode(ANSIcolorsonly)\n\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\n 1 function greet(){\n 2 -  console.log("Hello, World!");\n 2 +  console.log("Hello, Claude!");\n 3 }\n\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c\n Syntaxtheme:MonokaiExtended(ctrl+ttodisable)'

describe('detectAgentStartupIntervention', () => {
  it('recognises the Codex update menu with both versions and a safe default', () => {
    const found = detectAgentStartupIntervention('codex', CODEX_UPDATE_MENU)
    expect(found?.kind).toBe('update-available')
    expect(found?.update).toEqual({ currentVersion: '0.153.0', latestVersion: '0.154.0' })
    expect(found?.actions[0]).toMatchObject({ id: 'skip-update', keys: '2\r', recommended: true })
    expect(found?.actions.find((action) => action.id === 'update-now')).toMatchObject({
      keys: '1\r',
      exitsAgent: true
    })
  })

  it('reads through ANSI styling and line wrapping', () => {
    const styled = CODEX_UPDATE_MENU.replace(
      'Update available!',
      '\x1b[1;33mUpdate\x1b[0m \x1b[1mavailable!\x1b[0m'
    )
    expect(detectAgentStartupIntervention('codex', styled)?.kind).toBe('update-available')
  })

  it('recognises the Codex directory-trust prompt', () => {
    const found = detectAgentStartupIntervention('codex', CODEX_TRUST)
    expect(found?.kind).toBe('trust-prompt')
    expect(found?.actions.map((action) => action.id)).toEqual(['trust', 'quit'])
  })

  it('keeps Escape for the older closeable hooks review drawer', () => {
    const review = 'Hooks\n1 hook needs review before it can run.\nesc to close'
    const found = detectAgentStartupIntervention('codex', review)
    expect(found?.kind).toBe('automation-review')
    expect(found?.actions[0]).toMatchObject({ id: 'continue-without-automation', keys: '\x1b' })
  })

  it.each(['3', '4'])('declines hook trust using the visible numbered choice %s', (choice) => {
    // Captured 2026-09-15 from Codex 0.154.0 in the real PTY Chat test on mw0003.
    const review = [
      'Hooks need review',
      '6 hooks are new or changed.',
      'Hooks can run outside the sandbox after you trust them.',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      `  ${choice}. Continue without trusting (hooks won't run)`,
      'Press enter to confirm or esc to go back'
    ].join('\r\n')
    const found = detectAgentStartupIntervention('codex', review)
    expect(found?.actions).toEqual([
      { id: 'continue-without-automation', keys: `${choice}\r`, recommended: true },
      { id: 'open-terminal', keys: '', requiresTerminal: true }
    ])
    const serialized = review.replace(
      `${choice}. Continue without trusting`,
      `\x1b[2C${choice}.\x1b[1CContinue\x1b[1Cwithout\x1b[1Ctrusting`
    )
    expect(detectAgentStartupIntervention('codex', serialized)).toEqual(found)
  })

  it('requires Terminal when hook review has no known way to continue without trust', () => {
    const found = detectAgentStartupIntervention(
      'codex',
      'Hooks need review\n› 1. Trust all and continue\nPress enter to confirm or esc to go back'
    )
    expect(found?.actions).toEqual([{ id: 'open-terminal', keys: '', requiresTerminal: true }])
  })

  it('recognises the Claude folder-trust prompt and moves off "No, exit"', () => {
    const found = detectAgentStartupIntervention('claude', CLAUDE_TRUST)
    expect(found?.kind).toBe('trust-prompt')
    expect(found?.actions[0]).toMatchObject({ id: 'trust', keys: '\x1b[B\r' })
    const yesHighlighted = CLAUDE_TRUST.replace('❯ No, exit', '  No, exit').replace(
      '  Yes, I trust this folder',
      '❯ Yes, I trust this folder'
    )
    expect(detectAgentStartupIntervention('claude', yesHighlighted)?.actions[0]?.keys).toBe('\r')
  })

  it('recognises Claude onboarding and login screens', () => {
    expect(detectAgentStartupIntervention('claude', CLAUDE_ONBOARDING)?.kind).toBe('onboarding')
    const login = detectAgentStartupIntervention('claude', 'Select login method\n1. Claude account')
    expect(login?.kind).toBe('login-required')
    expect(login?.actions[0]).toMatchObject({ id: 'open-terminal', requiresTerminal: true })
  })

  it('holds the auto-mode offer and preserves the current permission mode', () => {
    const screen =
      'Make auto mode your default permission mode?\n❯ Yes, set auto mode as my default permission mode\n  No, keep bypass permissions'
    const result = detectAgentStartupIntervention('claude', screen)
    expect(result?.kind).toBe('permission-mode')
    expect(result?.actions[0]).toMatchObject({ id: 'keep-permission-mode', keys: '\x1b[B\r' })
    const declined = screen.replace('❯ Yes', '  Yes').replace('  No', '❯ No')
    expect(detectAgentStartupIntervention('claude', declined)?.actions[0]?.keys).toBe('\r')
    expect(
      detectAgentStartupIntervention('claude', 'I can make auto mode your default permission mode?')
    ).toBeNull()
  })

  it('reads Claude screens whose serialization dropped the spaces between words', () => {
    // Captured 2026-09-13 from Claude Code 2.1.269 through the app's screen reader.
    expect(detectAgentStartupIntervention('claude', CLAUDE_ONBOARDING_SERIALIZED)?.kind).toBe(
      'onboarding'
    )
    const squashedTrust = CLAUDE_TRUST.replace(/ /g, '')
    expect(detectAgentStartupIntervention('claude', squashedTrust)?.kind).toBe('trust-prompt')
    const squashedLogin = 'Selectloginmethod\n1.Claudeaccount'
    expect(detectAgentStartupIntervention('claude', squashedLogin)?.kind).toBe('login-required')
    const squashedCodexUpdate = CODEX_UPDATE_MENU.replace(/ /g, '')
    expect(detectAgentStartupIntervention('codex', squashedCodexUpdate)?.kind).toBe(
      'update-available'
    )
  })

  it('maps Claude-family agents onto the Claude screens and ignores others', () => {
    expect(detectAgentStartupIntervention('openclaude', CLAUDE_TRUST)?.agent).toBe('claude')
    expect(detectAgentStartupIntervention('claude-agent-teams', CLAUDE_TRUST)?.agent).toBe('claude')
    expect(detectAgentStartupIntervention('grok', CODEX_UPDATE_MENU)).toBeNull()
  })

  it('does not fire on ordinary work that mentions updates or trust', () => {
    expect(
      detectAgentStartupIntervention(
        'codex',
        '› Ask Codex to do anything\nI checked: an update available in npm; press enter to continue reading'
      )
    ).toBeNull()
    expect(
      detectAgentStartupIntervention('claude', 'Do you trust this analysis? I created a project')
    ).toBeNull()
    expect(detectAgentStartupIntervention('codex', null)).toBeNull()
    expect(detectAgentStartupIntervention('codex', '')).toBeNull()
  })
})

describe('Claude onboarding anchors', () => {
  it('recognises the bottom of the text-style screen when its heading scrolled off', () => {
    const bottom =
      '   6. Dark mode (ANSI colors only)\n   7. Light mode (ANSI colors only)\n\n ╌╌╌╌╌╌╌╌\n' +
      '  1  function greet() {\n  2 -  console.log("Hello, World!");\n  3  }\n ╌╌╌╌╌╌╌╌\n' +
      '  Syntax theme: Monokai Extended (ctrl+t to disable)'
    expect(detectAgentStartupIntervention('claude', bottom)?.kind).toBe('onboarding')
    expect(
      detectAgentStartupIntervention(
        'claude',
        '6.Darkmode(ANSIcolorsonly)\n7.Lightmode(ANSIcolorsonly)\nSyntaxtheme:MonokaiExtended(ctrl+ttodisable)'
      )?.kind
    ).toBe('onboarding')
  })

  it('does not turn a conversation about themes into an onboarding card', () => {
    const chat = [
      '❯ Please explain syntax theme settings and the syntaxTheme variable',
      '',
      '● Syntax themes control highlighting; the syntaxTheme variable selects one. You can',
      '  choose the text colours per token kind. Dark mode users often prefer Monokai.',
      '',
      '❯ '
    ].join('\n')
    expect(detectAgentStartupIntervention('claude', chat)).toBeNull()
    expect(
      detectAgentStartupIntervention('claude', '❯ Explain the syntaxTheme variable\n\n● Sure.')
    ).toBeNull()
  })
})
