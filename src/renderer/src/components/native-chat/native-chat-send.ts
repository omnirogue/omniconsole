// Pure: turn raw composer text into the exact PTY bytes to write. Kept separate
// from the React composer so the byte rules are unit-testable without a DOM.

import {
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from '../terminal-pane/terminal-bracketed-paste'
import type { TuiAgent } from '../../../../shared/tui-agent'

// Why: carriage return (not \n) is what xterm/agent composers treat as the
// submit/Enter key over a PTY.
const SUBMIT = '\r'

/** True when the draft spans more than one line (so it needs bracketed-paste
 *  wrapping). A trailing newline alone still counts as multi-line. */
export function isMultilineDraft(text: string): boolean {
  return /[\r\n]/.test(text)
}

/** The native Enter byte; buildNativeChatSubmitParts chooses its paste timing. */
export const NATIVE_CHAT_SUBMIT = SUBMIT

// Why: agent TUI composers treat Ctrl+U as kill-to-start-of-line. Chat sends
// start from an empty line so a prior cancelled paste cannot glue onto the next
// prompt. Not used on verified option commands — model-switch confirmation
// observes the PTY and Ctrl+U can miss confirmation markers.
//
// One Ctrl+U only ever clears ONE logical line. When the line may hold an
// injected multi-line launch draft, callers pass `clearInput` built by
// buildAgentTuiClearInputForText — see agent-tui-input-clear.ts for the measured
// 2N-1 law and the sequences that do NOT work.
export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'

/** Gap before re-reading the agent's input line to confirm a clear landed. */
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

/**
 * Compute the bytes for `text` WITHOUT the trailing submit:
 *  - single-line → `text`
 *  - multi-line  → `\x1b[200~…\x1b[201~` (bracketed-paste wrapped, no submit)
 *
 * Most agents need Enter after a paste settles; OMP needs it in the paste event.
 * Use buildNativeChatSubmitParts for the owning agent's submission behavior.
 */
export function buildNativeChatPasteBytes(text: string): string {
  if (isMultilineDraft(text)) {
    return wrapTerminalBracketedPasteText(text)
  }
  // Why: sanitize even unframed text so pasted scrollback cannot carry a raw
  // terminal escape into the agent composer.
  return sanitizeBracketedPasteText(text)
}

export function buildNativeChatSubmitParts(
  text: string,
  agent?: TuiAgent
): { body: string; submit: string } {
  const body = buildNativeChatPasteBytes(text)
  // Why: OMP's large-paste selector consumes a later Enter; the native paste event must carry submit.
  return agent === 'omp' && isMultilineDraft(text)
    ? { body: '', submit: body + SUBMIT }
    : { body, submit: SUBMIT }
}

/** Image attachments must look like a real terminal image paste to Claude/Codex
 *  TUIs. A plain typed path (or @file mention) is treated as text/file-read. */
export function buildNativeChatImagePasteBytes(filePath: string): string {
  return wrapTerminalBracketedPasteText(filePath)
}

/**
 * Compute the bytes to write for `text` + Enter in ONE write:
 *  - single-line → `text\r`
 *  - multi-line  → `\x1b[200~…\x1b[201~\r` (bracketed-paste wrapped, then submit)
 *
 * Live sends use buildNativeChatSubmitParts for agent-specific timing.
 */
export function buildNativeChatSendBytes(text: string): string {
  return `${buildNativeChatPasteBytes(text)}${SUBMIT}`
}
