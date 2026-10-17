// A session's goal, read mechanically: the first thing the person actually typed. Harness
// machinery (system reminders, command envelopes, notifications) is not the person, and
// pasted blocks are material rather than the ask, so both are stripped before the line.

import {
  isKnownHarnessInjectedUserTurnText,
  isKnownHarnessTagName
} from './harness-injected-user-turns'
import { isTextBlock, type NativeChatMessage } from './native-chat-types'
import { sessionPromptContent, stripPromptPasteMarkers } from './session-prompt-content'
import { sessionMissionFromPrompt, type SessionMission } from './session-mission'

/** One line: long enough to say what the session is for, short enough for a row. */
export const SESSION_GOAL_LINE_MAX = 140
/** Bounds the full text kept for hover so a multi-MB paste never reaches the UI. */
export const SESSION_GOAL_FULL_MAX = 2_000

export type SessionGoal = {
  mission?: SessionMission
  /** Single line, whitespace collapsed, pastes removed, truncated with an ellipsis. */
  line: string
  /** The prompt without harness blocks, for a hover or expanded view. */
  full: string
}

const TAG_BLOCK_RE = /<([a-z][a-z0-9_-]*)\b[^>]*>[\s\S]*?<\/\1>/g
// Context Codex writes into user-role records: instructions and environment, not the ask.
const PROVIDER_CONTEXT_TAGS: ReadonlySet<string> = new Set([
  'codex_internal_context',
  'environment_context',
  'goal_context',
  'user_instructions'
])
const INSTRUCTION_DUMP_PREFIXES = ['# agents.md instructions', '<instructions>']
const FENCED_BLOCK_RE = /(?:```|~~~)[\s\S]*?(?:```|~~~|$)/g

function withoutHarnessBlocks(text: string): string {
  return text.replace(TAG_BLOCK_RE, (block, name: string) =>
    isKnownHarnessTagName(name) || PROVIDER_CONTEXT_TAGS.has(name) ? ' ' : block
  )
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The goal a prompt states, or null when the prompt is harness machinery or only pastes. */
export function sessionGoalFromPrompt(prompt: string | null | undefined): SessionGoal | null {
  const trimmed = prompt?.trim() ?? ''
  if (!trimmed || isKnownHarnessInjectedUserTurnText(trimmed)) {
    return null
  }
  const head = trimmed.slice(0, 64).toLowerCase()
  if (INSTRUCTION_DUMP_PREFIXES.some((prefix) => head.startsWith(prefix))) {
    return null
  }
  const full = stripPromptPasteMarkers(
    withoutHarnessBlocks(sessionPromptContent(trimmed, SESSION_GOAL_FULL_MAX * 4))
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const line = oneLine(full.replace(FENCED_BLOCK_RE, ' '), SESSION_GOAL_LINE_MAX)
  if (!line) {
    return null
  }
  const mission = sessionMissionFromPrompt(full)
  return { line, full: boundedFull(full), ...(mission ? { mission } : {}) }
}

function boundedFull(full: string): string {
  return full.length > SESSION_GOAL_FULL_MAX
    ? `${full.slice(0, SESSION_GOAL_FULL_MAX - 1).trimEnd()}…`
    : full
}

/**
 * The first genuine user prompt inside an assembled transcript window, or null. Only trust
 * this when the window reaches the start of the session; otherwise it is a later prompt.
 */
export function firstSessionGoalInMessages(
  messages: readonly NativeChatMessage[]
): SessionGoal | null {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    const text = message.blocks
      .flatMap((block) => (isTextBlock(block) ? [block.text] : []))
      .join('\n')
    const goal = sessionGoalFromPrompt(text)
    if (goal) {
      return goal
    }
  }
  return null
}
