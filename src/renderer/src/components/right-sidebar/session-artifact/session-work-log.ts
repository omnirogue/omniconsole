import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { stripInlineMarkdown } from '@/components/session-activity/session-activity-text'

/** One turn of the session as the Work log lists it: what was asked and what came of it. */
export type SessionWorkLogTurn = {
  id: string
  prompt: string
  startedAt: number | null
  endedAt: number | null
  /** Tool calls the agent made in this turn. */
  steps: number
  /** The agent's last line in this turn; null while it has not replied yet. */
  result: string | null
  /** How a turn read from hook history ended, when its reply text is not known. */
  ended?: 'finished' | 'interrupted' | 'failed'
}

export type SessionWorkLogStatus = Pick<
  AgentStatusEntry,
  | 'state'
  | 'prompt'
  | 'stateStartedAt'
  | 'stateHistory'
  | 'interrupted'
  | 'failed'
  | 'sessionBoundary'
  | 'lastAssistantMessage'
  | 'lastAssistantMessageIsToolOutput'
  | 'lastCompletedAssistantMessage'
>

const WORK_LOG_MAX_TURNS = 20
const WORK_LOG_TEXT_MAX = 160

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
}

function oneLine(text: string): string {
  const line = stripInlineMarkdown(text.split('\n').find((part) => part.trim()) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > WORK_LOG_TEXT_MAX ? `${line.slice(0, WORK_LOG_TEXT_MAX - 1)}…` : line
}

/**
 * The session's turns, newest first, read from the transcript the panel already shares. Why skip
 * `<…>` user entries: providers inject command output and task notifications as user messages,
 * and those are not something the person asked.
 */
export function sessionWorkLogTurns(messages: readonly NativeChatMessage[]): SessionWorkLogTurn[] {
  const turns: SessionWorkLogTurn[] = []
  let current: SessionWorkLogTurn | null = null
  for (const message of messages) {
    const text = messageText(message)
    if (message.role === 'user' && text && !text.startsWith('<')) {
      if (current) {
        turns.push(current)
      }
      current = {
        id: message.id,
        prompt: oneLine(text),
        startedAt: message.timestamp,
        endedAt: message.timestamp,
        steps: 0,
        result: null
      }
      continue
    }
    if (!current) {
      continue
    }
    current.endedAt = message.timestamp ?? current.endedAt
    current.steps += message.blocks.filter((block) => block.type === 'tool-call').length
    if (message.role === 'assistant' && text) {
      current.result = oneLine(text)
    }
  }
  if (current) {
    turns.push(current)
  }
  return turns.slice(-WORK_LOG_MAX_TURNS).toReversed()
}

/**
 * The same turns read from the agent's hook history, for a provider whose transcript the app
 * cannot read. A turn begins at the first phase after a finished one, so two turns asking the same
 * thing stay two; waiting or blocked phases continue it. Why the reply only on the newest finished
 * turn: the hook row keeps that one reply, not one per turn.
 */
export function statusWorkLogTurns(status: SessionWorkLogStatus | undefined): SessionWorkLogTurn[] {
  if (!status) {
    return []
  }
  const phases = [
    ...status.stateHistory,
    {
      state: status.state,
      prompt: status.prompt,
      startedAt: status.stateStartedAt,
      interrupted: status.interrupted,
      failed: status.failed,
      sessionBoundary: status.sessionBoundary
    }
  ]
  const turns: SessionWorkLogTurn[] = []
  let turn: SessionWorkLogTurn | null = null
  for (const phase of phases) {
    // Why: a session boundary (start, resume, clear) ends any turn and is not one itself.
    if (phase.sessionBoundary === true) {
      turn = null
      continue
    }
    const prompt = oneLine(phase.prompt ?? '')
    if (!turn || turn.ended !== undefined) {
      if (!prompt || (phase.state === 'done' && turn?.ended !== undefined)) {
        continue
      }
      turn = {
        id: `status:${phase.startedAt}`,
        prompt,
        startedAt: phase.startedAt,
        endedAt: phase.startedAt,
        steps: 0,
        result: null
      }
      turns.push(turn)
    }
    turn.endedAt = phase.startedAt
    if (phase.state === 'done') {
      turn.ended = phase.failed ? 'failed' : phase.interrupted ? 'interrupted' : 'finished'
    }
  }
  const open = status.state !== 'done' && status.sessionBoundary !== true
  const reply =
    status.state === 'done' &&
    status.sessionBoundary !== true &&
    status.lastAssistantMessageIsToolOutput !== true
      ? status.lastAssistantMessage
      : status.lastCompletedAssistantMessage
  const replied = open ? turns.at(-2) : turns.at(-1)
  if (replied && reply) {
    replied.result = oneLine(reply)
  }
  return turns.slice(-WORK_LOG_MAX_TURNS).toReversed()
}
