import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { hasOptionalAutomationReview } from './agent-setup-review'

/**
 * Startup screens an agent TUI can draw over its composer. Each one swallows
 * whatever bytes arrive next, so a chat prompt pasted while one is showing is
 * answered by the menu, not the model — the audited Codex updater case
 * (send → "Update now" → npm install → exit). Detection is screen-text based,
 * mirroring the runtime's terminal-wait classifier, so both sides agree.
 */
export type AgentStartupInterventionKind =
  | 'update-available'
  | 'automation-review'
  | 'trust-prompt'
  | 'login-required'
  | 'onboarding'
  | 'permission-mode'
  | 'model-migration'
  | 'cwd-prompt'

export type AgentStartupInterventionAgent = 'codex' | 'claude'

export type AgentStartupInterventionAction = {
  id:
    | 'update-now'
    | 'skip-update'
    | 'skip-update-until-next'
    | 'trust'
    | 'quit'
    | 'continue'
    | 'keep-permission-mode'
    | 'continue-without-automation'
    | 'open-terminal'
  /** Bytes written to the PTY; empty when the person must act in the terminal. */
  keys: string
  /** The agent process ends after this choice (Codex updates then quits). */
  exitsAgent?: boolean
  /** Sends nothing: sign-in flows open a browser and need the real terminal. */
  requiresTerminal?: boolean
  /** The safe default, listed first. */
  recommended?: boolean
}

export type AgentStartupIntervention = {
  kind: AgentStartupInterventionKind
  agent: AgentStartupInterventionAgent
  actions: AgentStartupInterventionAction[]
  update?: { currentVersion: string | null; latestVersion: string | null }
}

const ENTER = '\r'
const ESC = '\x1b'
const ARROW_DOWN = '\x1b[B'
const VERSION_ARROW_RE =
  /(\d+\.\d+\.\d+(?:-[0-9a-z.]+)?)\s*(?:->|→)\s*(\d+\.\d+\.\d+(?:-[0-9a-z.]+)?)/i

function normalize(screen: string): string {
  return stripAnsiEscapeSequences(screen).replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Why whitespace-blind: serialized screens of Ink-style TUIs (Claude Code) lose the
 * spaces between differently styled words — the real 2.1.269 onboarding reads
 * "Choosethetextstylethatlooksbestwithyourterminal" — so a phrase must match
 * with all whitespace removed on both sides, not only as typed.
 */
function has(text: string, phrase: string): boolean {
  if (text.includes(phrase)) {
    return true
  }
  const squashed = text.replace(/\s+/g, '')
  return squashed.includes(phrase.replace(/\s+/g, ''))
}

export function agentStartupInterventionAgent(
  agent: string | null | undefined
): AgentStartupInterventionAgent | null {
  if (agent === 'codex') {
    return 'codex'
  }
  // Why: OpenClaude and Agent Teams run the Claude Code TUI and draw its prompts.
  if (agent === 'claude' || agent === 'openclaude' || agent === 'claude-agent-teams') {
    return 'claude'
  }
  return null
}

function detectCodex(raw: string, text: string): AgentStartupIntervention | null {
  if (hasOptionalAutomationReview(raw)) {
    // Why: Codex 0.154's startup menu uses an explicit numbered decline;
    // Escape only goes back. Older /hooks drawers can still close with Escape.
    const decline = stripAnsiEscapeSequences(raw).match(
      /(?:^|\n)\s*[›❯>]?\s*([1-9])\.\s*continue\s*without\s*trusting\b/i
    )
    const keys = decline ? `${decline[1]}${ENTER}` : has(text, 'esc to close') ? ESC : null
    return {
      kind: 'automation-review',
      agent: 'codex',
      actions: [
        ...(keys ? [{ id: 'continue-without-automation' as const, keys, recommended: true }] : []),
        { id: 'open-terminal', keys: '', requiresTerminal: true }
      ]
    }
  }
  if (
    has(text, 'update available') &&
    has(text, 'update now') &&
    has(text, 'press enter to continue')
  ) {
    const versions = VERSION_ARROW_RE.exec(text)
    return {
      kind: 'update-available',
      agent: 'codex',
      update: { currentVersion: versions?.[1] ?? null, latestVersion: versions?.[2] ?? null },
      // Why digits: Codex's list popups select by number; the Enter after a
      // digit confirms on builds that only highlight, and lands harmlessly on
      // the composer on builds that already confirmed.
      actions: [
        { id: 'skip-update', keys: `2${ENTER}`, recommended: true },
        { id: 'skip-update-until-next', keys: `3${ENTER}` },
        { id: 'update-now', keys: `1${ENTER}`, exitsAgent: true }
      ]
    }
  }
  if (has(text, 'do you trust the contents of this directory')) {
    return {
      kind: 'trust-prompt',
      agent: 'codex',
      actions: [
        { id: 'trust', keys: `1${ENTER}`, recommended: true },
        { id: 'quit', keys: `2${ENTER}`, exitsAgent: true }
      ]
    }
  }
  if (has(text, 'codex just got an upgrade') && has(text, 'press enter to continue')) {
    return {
      kind: 'model-migration',
      agent: 'codex',
      actions: [{ id: 'continue', keys: ENTER, recommended: true }]
    }
  }
  if (has(text, 'choose working directory to') && has(text, 'press enter to continue')) {
    return {
      kind: 'cwd-prompt',
      agent: 'codex',
      actions: [{ id: 'continue', keys: ENTER, recommended: true }]
    }
  }
  if (
    has(text, 'sign in with chatgpt') ||
    (has(text, 'welcome to codex') && has(text, 'api key'))
  ) {
    return {
      kind: 'login-required',
      agent: 'codex',
      actions: [{ id: 'open-terminal', keys: '', requiresTerminal: true, recommended: true }]
    }
  }
  return null
}

/** Claude's trust selector highlights "No, exit" first; move to "Yes" only when needed. */
function claudeTrustKeys(raw: string): string {
  const lines = stripAnsiEscapeSequences(raw).split(/\r?\n/)
  const yesLine = lines.find((line) => /yes,?\s*i\s*trust/i.test(line))
  return yesLine && /^\s*[❯>]/.test(yesLine) ? ENTER : `${ARROW_DOWN}${ENTER}`
}

function detectClaude(raw: string, text: string): AgentStartupIntervention | null {
  if (
    text.includes('make auto mode your default permission mode?') &&
    text.includes('yes, set auto mode') &&
    text.includes('no, keep')
  ) {
    const keepingCurrent = stripAnsiEscapeSequences(raw)
      .split(/\r?\n/)
      .some((line) => /^\s*[❯>]\s*No,\s*keep\b/i.test(line))
    return {
      kind: 'permission-mode',
      agent: 'claude',
      actions: [
        {
          id: 'keep-permission-mode',
          keys: keepingCurrent ? ENTER : `${ARROW_DOWN}${ENTER}`,
          recommended: true
        },
        { id: 'open-terminal', keys: '', requiresTerminal: true }
      ]
    }
  }
  if (
    has(text, 'is this a project you created or one you trust') ||
    has(text, 'do you trust the files in this folder')
  ) {
    return {
      kind: 'trust-prompt',
      agent: 'claude',
      actions: [
        { id: 'trust', keys: claudeTrustKeys(raw), recommended: true },
        { id: 'quit', keys: ESC, exitsAgent: true }
      ]
    }
  }
  // Why these anchors: the 2.1.269 text-style screen is taller than a short pane, which
  // then shows only its bottom — the ANSI/colorblind options, the preview diff and the
  // "Syntax theme: … (ctrl+t to disable)" footer. A bare "syntax theme" would also match
  // a person asking about syntax themes in chat, so each anchor needs its neighbour.
  if (
    has(text, 'choose the text style') ||
    (has(text, 'syntax theme') && has(text, 'ctrl+t to disable')) ||
    (has(text, 'dark mode (ansi colors only)') && has(text, 'light mode (ansi colors only)'))
  ) {
    return {
      kind: 'onboarding',
      agent: 'claude',
      actions: [{ id: 'continue', keys: ENTER, recommended: true }]
    }
  }
  if (
    has(text, 'select login method') ||
    has(text, 'log in to claude') ||
    has(text, 'paste code here') ||
    has(text, "browser didn't open")
  ) {
    return {
      kind: 'login-required',
      agent: 'claude',
      actions: [{ id: 'open-terminal', keys: '', requiresTerminal: true, recommended: true }]
    }
  }
  return null
}

/**
 * Classify the current TUI screen. Null means no startup screen is covering
 * the composer — not proof the composer is ready, which each caller still
 * checks with its own agent-specific signal.
 */
export function detectAgentStartupIntervention(
  agent: string | null | undefined,
  screen: string | null | undefined
): AgentStartupIntervention | null {
  const kind = agentStartupInterventionAgent(agent)
  if (!kind || !screen) {
    return null
  }
  const text = normalize(screen)
  return kind === 'codex' ? detectCodex(screen, text) : detectClaude(screen, text)
}
