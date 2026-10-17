/**
 * What a live pane's agent is doing, read without waiting for its next hook event: after a restart
 * an idle agent reports nothing until it next acts, so the host reads what it can observe now.
 *
 * - Process: the pane's foreground process by name (state), and by pid (`terminal-agent-process.ts`,
 *   the proof a prompt is bound to). A shell the process table confirms in the foreground is the
 *   agent gone.
 * - Screen: the rendered screen. A startup, trust or approval prompt the runtime's own detector
 *   recognizes is the person's to answer; a turn in flight and a finished turn each have their own
 *   positive marker (captured from Claude Code 2.1.281 and Codex on 2026-09-24). A screen with
 *   neither proves nothing.
 */

import {
  findCodexConversationLockIndex,
  hasTerminalWorkingMarker
} from '../../shared/automation-terminal-chrome'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-terminal-contracts'
import { isShellProcess } from '../../shared/shell-process-detection'
import { screenShowsPromptMenu } from '../session-manage/session-prompt-screen-evidence'
import type { TerminalAgentProcessProof, TerminalProcessTree } from './terminal-agent-process'
import { hasCodexShortCompletion } from './codex-short-completion'
import {
  remapTerminalScreenDecorations,
  type TerminalScreenDecoration
} from '../../shared/terminal-codex-recap'

export type TerminalForegroundEvidence =
  | { kind: 'agent'; agent: string }
  /** The shell is confirmed back in the foreground: whatever agent ran here has exited. */
  | { kind: 'shell' }
  /** Something that is neither a recognized agent nor a shell. */
  | { kind: 'program'; process: string }
  | { kind: 'unavailable' }

export type TerminalScreenEvidence = {
  blocked: RuntimeTerminalWaitBlockedReason | null
  /** Conservative input block, not proof of a parseable prompt. */
  promptMenu?: boolean
  /** The provider refuses this pane because its conversation has another owner. */
  conversationLocked?: boolean
  /** A turn-in-flight marker in the status area. */
  working: boolean
  /** A finished-turn line in the status area, and no turn in flight. */
  turnDone: boolean
  /** A ready prompt the runtime's `tui-idle` detector recognizes, in the status area. */
  readyPrompt: boolean
}

export type TerminalAgentEvidence = {
  foreground: TerminalForegroundEvidence
  /** The agent process holding the foreground, by pid; null when unproven. */
  process: TerminalAgentProcessProof | null
  /** What a process table sampled now says about exit; null when none could be read. */
  tree: TerminalProcessTree | null
  /** Null when no rendered screen could be read. */
  screen: TerminalScreenEvidence | null
}

/** Agents whose finished-turn and working markers are both proven from real screens. */
export const SCREEN_MARKED_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex'])

// Why: Claude Code's native install runs `~/.local/share/claude/versions/<version>`, so the
// kernel names its process by the version (measured on laptop 2026-09-24: "2.1.280"); its
// command line still starts `…/bin/claude`, which the fresh scan recognizes first.
const CLAUDE_NATIVE_VERSION_PROCESS_RE = /^\d+\.\d+\.\d+$/
// Codex: "Worked for 8m 8s · done Sep 15 at 5:54 AM"; Claude: "✻ Cogitated for 1s · done 10:08 AM".
const TURN_DONE_RE = /\bfor (?:\d+\s*[hms]\s*)+· done\b/i
// Codex omits ‘done’ and uses either ‘·’ or ‘•’ before the completion clock.
const CODEX_TURN_DONE_RE =
  /\bWorked for (?:\d+\s*[hms]\s*)+[·•] (?:[A-Z][a-z]{2} \d{1,2} at )?\d{1,2}:\d{2}(?:\s*[AP]M)?\b/i
// Codex paints braille sparkles over blank cells, sometimes between words.
const BRAILLE_RE = /[⠀-⣿]/g
const STATUS_AREA_LINES = 15

async function readName(read: () => Promise<string | null>): Promise<string | null> {
  try {
    return (await read())?.trim() || null
  } catch {
    return null
  }
}

export async function classifyForegroundProcess(input: {
  read: () => Promise<string | null>
  /** A fresh process-table scan by command line; null when it cannot be made. */
  confirm?: () => Promise<string | null>
  confirmShell: () => Promise<boolean>
  /** The agent the pane was launched as; names a version-titled process when no scan can. */
  expectedAgent?: string | null
}): Promise<TerminalForegroundEvidence> {
  const name = await readName(input.read)
  const recognized = recognizeAgentProcess(name)
  if (recognized) {
    return { kind: 'agent', agent: recognized.agent }
  }
  if (!name) {
    return { kind: 'unavailable' }
  }
  const confirmed = input.confirm ? await readName(input.confirm) : null
  const confirmedAgent = recognizeAgentProcess(confirmed)
  if (confirmedAgent) {
    return { kind: 'agent', agent: confirmedAgent.agent }
  }
  if (isShellProcess(name) || (confirmed !== null && isShellProcess(confirmed))) {
    let shell = false
    try {
      shell = await input.confirmShell()
    } catch {
      shell = false
    }
    // An unconfirmed shell reading proves nothing either way.
    return shell ? { kind: 'shell' } : { kind: 'unavailable' }
  }
  if (
    confirmed === null &&
    input.expectedAgent === 'claude' &&
    CLAUDE_NATIVE_VERSION_PROCESS_RE.test(name)
  ) {
    return { kind: 'agent', agent: 'claude' }
  }
  return { kind: 'program', process: confirmed ?? name }
}

export function readScreenEvidence(
  lines: readonly string[],
  detectors: {
    blockedReason: (text: string) => RuntimeTerminalWaitBlockedReason | null
    readyPrompt: (text: string) => boolean
  },
  completedCodexReply?: string | null,
  screenDecorations?: readonly TerminalScreenDecoration[]
): TerminalScreenEvidence {
  const cleaned = lines.map((line) => line.replace(BRAILLE_RE, ' ').replace(/\s+/g, ' ').trim())
  const statusRows = cleaned.flatMap((line, row) => (line ? [row] : [])).slice(-STATUS_AREA_LINES)
  const status = statusRows.map((row) => cleaned[row])
  const decorations = remapTerminalScreenDecorations(screenDecorations, statusRows)
  const blocked = detectors.blockedReason(cleaned.join('\n'))
  const working = status.some(hasTerminalWorkingMarker)
  const promptMenu = !working && screenShowsPromptMenu(status.join('\n'))
  const shortCompletion =
    !working &&
    !blocked &&
    !promptMenu &&
    hasCodexShortCompletion(status, completedCodexReply, decorations)
  const conversationLocked =
    !working &&
    blocked === 'codex-interactive-prompt' &&
    findCodexConversationLockIndex(status.join('\n')) !== null
  return {
    blocked,
    ...(conversationLocked ? { conversationLocked: true } : {}),
    ...(promptMenu ? { promptMenu: true } : {}),
    working,
    turnDone:
      shortCompletion ||
      (!working && status.some((line) => TURN_DONE_RE.test(line) || CODEX_TURN_DONE_RE.test(line))),
    // Why the status area only: a ready banner stays in scrollback for the whole session.
    readyPrompt: shortCompletion || detectors.readyPrompt(status.join('\n'))
  }
}
