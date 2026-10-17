import { createHash } from 'node:crypto'
import type { SessionManagePrompt } from '../../shared/session-manage-types'

export type SessionPromptOption = {
  n: number
  label: string
  /**
   * What answering with it sends: a menu key on a terminal, a provider option id on a chat. Empty
   * when a terminal option has no single verified key, so it can never be chosen.
   */
  value: string
  role?: 'allow-once' | 'deny'
}

export type SessionPrompt = {
  ask: SessionManagePrompt
  options: SessionPromptOption[]
  readable: boolean
  /**
   * The command or question this prompt is about, from the prompt itself (never from a hook report
   * that may arrive later): the screen's command block, the structured title and detail, or the
   * question. This is display context, never proof that a previous prompt closed.
   */
  subject: string
  /**
   * The full command or tool call from each source that states it on its own (the agent's hook
   * report, the command block parsed off the screen, the structured item's detail) and a
   * question's header. Each is checked for hard stops by itself, and all of it is fingerprinted.
   */
  commandText: string[]
  delivery:
    | {
        kind: 'structured'
        sessionId: string
        fence: number
        itemId: string
        revision: number
        freeTextQuestionId?: string
      }
    | { kind: 'pty'; handle: string; ptyId: string; screen: string }
    /**
     * An async question (Codex `request_user_input_async`): no selector, the answer is a message.
     * `askedAt` identifies this asking (the question's own `askedAt`, else its row's state time).
     */
    | { kind: 'message'; handle: string; ptyId: string; askedAt: number }
    | { kind: 'unavailable'; reason: string }
}

type FingerprintedPrompt = {
  kind: SessionManagePrompt['kind']
  text: string
  options: readonly SessionPromptOption[]
  readable: boolean
  commandText: readonly string[]
}

/**
 * The identity `--expect` pins: the kind, the full text, whether it read completely, every command
 * source, and each option's number, label, role and the exact value an answer would send. Moving
 * the menu cursor changes none of these; any change to what could be approved or sent does.
 */
export function promptFingerprint(prompt: FingerprintedPrompt): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'session-prompt/2',
        prompt.kind,
        prompt.text,
        prompt.readable,
        prompt.commandText,
        prompt.options.map(({ n, label, role, value }) => [n, label, role ?? null, value])
      ])
    )
    .digest('hex')
}

export function describeSessionPrompt(
  kind: SessionManagePrompt['kind'],
  text: string,
  options: readonly SessionPromptOption[],
  readable: boolean,
  commandText: readonly string[] = []
): SessionManagePrompt {
  const visibleText = [text, ...commandText.filter((value) => value && !text.includes(value))]
    .filter((value, index, all) => all.indexOf(value) === index)
    .join('\n')
  return {
    kind,
    text: visibleText,
    options: options.map(({ n, label }) => ({ n, label })),
    fingerprint: promptFingerprint({ kind, text: visibleText, options, readable, commandText })
  }
}

export function promptTextIncomplete(text: string): boolean {
  return (
    !text.trim() ||
    /…|\.{3}|\[OmniConsole: output truncated/.test(text) ||
    promptHasControlCharacters(text)
  )
}

export function promptHasControlCharacters(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
  })
}

const SCOPE_PLACE = String.raw`(?:sessions?|conversations?|chats?|threads?|projects?|workspaces?|repos?|repositor(?:y|ies)|director(?:y|ies)|folders?|worktrees?)`
const SCOPE_SET = String.raw`(?:files?|paths?|commands?|tools?|hosts?|domains?|edits?|requests?)`
const SCOPE_WORD = String.raw`(?:[\w.*/@:~-]+\s+)?`

/**
 * An approval that outlives this one call, or reaches past it: "don't ask again", "always",
 * "for this session/directory/project/workspace", "permanently", "allow all" and the like.
 * `allow all` must not match a one-time option's label + provider id, e.g. "Allow allow".
 */
const PERSISTENT_APPROVAL = new RegExp(
  [
    String.raw`don['’]?t ask|do not ask|never ask|stop asking|no longer ask|without asking`,
    String.raw`don['’]?t (?:prompt|confirm|check)`,
    String.raw`\balways\b|\bremember|\bpermanent|\bforever\b|\bfrom now on\b|\bgoing forward\b`,
    String.raw`\bevery time\b|\bglobally\b|\bin (?:the )?future\b`,
    String.raw`\b(?:session|project|workspace|directory|folder|repo|repository|global|system)[- ]wide\b`,
    String.raw`\b(?:for|in|during|across|throughout|within)\s+(?:(?:the\s+)?(?:this|current|entire|whole|all|every|any|future|rest of (?:this|the))\s+${SCOPE_WORD}|the\s+)${SCOPE_PLACE}\b`,
    String.raw`\b(?:for|to|on|across)\s+(?:all|every|any|future|these|similar)\s+${SCOPE_WORD}${SCOPE_SET}\b`,
    String.raw`allow[-_ ]?all(?!ow)`,
    String.raw`\b(?:allow|approve|accept|yes|trust)\s+(?:to\s+)?(?:all|every|any|everything)\b`,
    String.raw`\bauto[-_ ]?(?:approve|accept|allow|run)|\bbypass|\btrust\b`,
    String.raw`ForSession|for_session`
  ].join('|'),
  'i'
)

export function persistentApproval(text: string): boolean {
  return PERSISTENT_APPROVAL.test(text)
}

/**
 * A menu row that opens a free-text editor instead of committing an answer ("Other", "Type
 * something"). Such a row is never chosen: what it would send cannot be verified.
 */
export function freeEntryOption(label: string): boolean {
  const first = (label.split('\n')[0] ?? '').trim()
  return /^(?:type something|type (?:your own|an?|a custom|another) (?:answer|response|reply)|other|other \((?:please )?specify\)|something else|none of (?:the above|these)|custom(?: answer| response)?|(?:enter|write) (?:your own|a custom) (?:answer|response)|chat about this)[.…:]*$/i.test(
    first
  )
}

/** The only key a terminal question option may commit with: its own digit. */
export function questionOptionKey(option: SessionPromptOption): boolean {
  return /^[1-9]$/.test(option.value) && option.value === String(option.n)
}

/**
 * The one-time allow and deny options `--allow` / `--deny` may pick, as an ALLOWLIST: an option
 * that is not one of these known shapes is never chosen, whatever role a parser gave it.
 * Structured sessions answer by provider option id (Claude `allow`/`deny`, Codex app-server
 * `accept`/`decline`); terminal sessions by the exact label and keystroke of the Claude or Codex
 * permission menu (`session-prompt-screen.ts`).
 */
export const STRUCTURED_ALLOW_ONCE_IDS: ReadonlySet<string> = new Set(['allow', 'accept'])
export const STRUCTURED_DENY_IDS: ReadonlySet<string> = new Set(['deny', 'decline'])
export const CLAUDE_SCREEN_ALLOW_ONCE = /^(?:Yes|Yes, allow once|Allow once)$/
export const CODEX_SCREEN_ALLOW_ONCE = /^Yes, proceed \(y\)$/
export const CLAUDE_SCREEN_DENY = /^(?:No|No, and tell Claude what to do differently)$/
export const CODEX_SCREEN_DENY = /^No, and tell Codex what to do differently \(esc\)$/
/** The one keystroke that commits a screen menu's deny (Esc cancels the permission). */
export const SCREEN_DENY_KEY = '\x1b'

export function isKnownOneTimeAllow(
  option: SessionPromptOption,
  delivery: SessionPrompt['delivery']['kind']
): boolean {
  if (option.role !== 'allow-once' || persistentApproval(`${option.label} ${option.value}`)) {
    return false
  }
  if (delivery === 'structured') {
    return STRUCTURED_ALLOW_ONCE_IDS.has(option.value)
  }
  if (delivery === 'pty') {
    return (
      (CLAUDE_SCREEN_ALLOW_ONCE.test(option.label) && option.value === String(option.n)) ||
      (CODEX_SCREEN_ALLOW_ONCE.test(option.label) && option.value === 'y')
    )
  }
  return false
}

export function isKnownDeny(
  option: SessionPromptOption,
  delivery: SessionPrompt['delivery']['kind']
): boolean {
  if (option.role !== 'deny') {
    return false
  }
  if (delivery === 'structured') {
    return STRUCTURED_DENY_IDS.has(option.value)
  }
  if (delivery === 'pty') {
    return (
      (CLAUDE_SCREEN_DENY.test(option.label) || CODEX_SCREEN_DENY.test(option.label)) &&
      option.value === SCREEN_DENY_KEY
    )
  }
  return false
}
