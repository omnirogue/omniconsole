import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from '../../agent-status-types'
import {
  addCodexAsyncAsk,
  codexAsyncAskEnvelope,
  codexAsyncAskTranscriptStart,
  codexAsyncCallAccepted,
  codexTurnOverInStatus,
  isCodexAsyncQuestionTool,
  remainingAfterCodexTranscript,
  remainingCodexAsyncAsk,
  serializeCodexAsyncAskEnvelope,
  withoutCodexAsyncCall
} from '../../codex-async-question'
import {
  codexAsyncAskFromEnvelope,
  withoutDismissedCodexAsyncQuestions,
  type ShownAsyncQuestion
} from '../../codex-async-question-dismissal'
import {
  codexTranscriptSize,
  readCodexUserMessagesSince
} from '../../codex-async-question-transcript'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

/**
 * The pane's open async questions as the status prompt, once the lead's turn is over and nothing
 * else holds the pane. Why not mid-turn: the question is still in Codex's own ⌥+↑ UI then, and a
 * card would hide the composer. Why not while a child waits: the pane then shows that child's
 * approval or question, and an answer's Enter would land there.
 */
export function codexAsyncAskPrompt(
  state: HookListenerState,
  paneKey: string,
  pane: { state: string; workingMode?: string }
): string | undefined {
  const ask = state.codexAsyncAskByPaneKey.get(paneKey)
  return ask &&
    state.codexLeadStateByPaneKey.get(paneKey)?.state === 'done' &&
    codexTurnOverInStatus(pane)
    ? serializeCodexAsyncAskEnvelope(ask.envelope, AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
    : undefined
}

function envelopeOf(interactivePrompt: string): ReturnType<typeof codexAsyncAskEnvelope> {
  try {
    return codexAsyncAskEnvelope(JSON.parse(interactivePrompt))
  } catch {
    return null
  }
}

/**
 * The person dismissed these questions on a card (closed it, or left them out of an answer). Codex
 * keeps no copy past the turn that asked them, so they leave the pane for good. `rowPrompt` is the
 * async prompt the row shows, if it shows one. Returns the prompt left over (undefined when no
 * question is), or null when none of them was open.
 */
export function dismissCodexAsyncQuestions(
  state: HookListenerState,
  paneKey: string,
  rowPrompt: string | undefined,
  shown: readonly ShownAsyncQuestion[]
): { interactivePrompt: string | undefined } | null {
  const tracked = state.codexAsyncAskByPaneKey.get(paneKey)
  const snapshot = state.lastToolByPaneKey.get(paneKey)
  const prompt = rowPrompt ?? snapshot?.interactivePrompt
  const envelope = tracked || !prompt ? null : envelopeOf(prompt)
  const ask = tracked ?? (envelope ? codexAsyncAskFromEnvelope(envelope) : null)
  if (!ask) {
    return null
  }
  const left = withoutDismissedCodexAsyncQuestions(ask, shown)
  if (left?.envelope.asyncQuestions.length === ask.envelope.asyncQuestions.length) {
    return null
  }
  if (tracked && left) {
    state.codexAsyncAskByPaneKey.set(paneKey, left)
  } else if (tracked) {
    state.codexAsyncAskByPaneKey.delete(paneKey)
  }
  const interactivePrompt = left
    ? serializeCodexAsyncAskEnvelope(left.envelope, AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
    : undefined
  // Why: a turn-end ask (turn-end-question.ts) lives in the tool snapshot, which cached
  // payloads re-emit; clear or narrow it so a child's next event or dismissing a tracked
  // native ask cannot bring the turn-end card back.
  if (snapshot?.interactivePrompt && envelopeOf(snapshot.interactivePrompt)) {
    state.lastToolByPaneKey.set(paneKey, {
      ...snapshot,
      interactivePrompt: tracked ? undefined : interactivePrompt
    })
  }
  return { interactivePrompt }
}

function toolNameOf(hookPayload: Record<string, unknown>): string | undefined {
  return readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
}

function transcriptPathOf(hookPayload: Record<string, unknown>): string | undefined {
  return readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
}

/** Tracks the lead's open async questions: set by its tool call, narrowed or cleared by what the
 *  person sends next. Call it before the lead's state is updated for this event. */
export function trackCodexAsyncAsk(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  const asks = state.codexAsyncAskByPaneKey
  const store = (ask: ReturnType<typeof asks.get> | null): void => {
    if (ask) {
      asks.set(paneKey, ask)
    } else {
      asks.delete(paneKey)
    }
  }
  if (eventName === 'PreToolUse' && isCodexAsyncQuestionTool(toolNameOf(hookPayload))) {
    const path = transcriptPathOf(hookPayload)
    const offset = path ? codexTranscriptSize(path) : null
    const ask = addCodexAsyncAsk(
      asks.get(paneKey),
      hookPayload.tool_input ?? hookPayload.input ?? hookPayload.arguments,
      readFirstString(hookPayload, ['tool_use_id', 'call_id']),
      path && offset !== null ? { path, offset } : undefined
    )
    if (ask) {
      asks.set(paneKey, ask)
    }
  } else if (eventName === 'PostToolUse' && isCodexAsyncQuestionTool(toolNameOf(hookPayload))) {
    const ask = asks.get(paneKey)
    const response = hookPayload.tool_response ?? hookPayload.response
    // Why: only an accepted call put its questions in front of the person; no response says nothing.
    if (ask && response !== undefined && !codexAsyncCallAccepted(response)) {
      store(withoutCodexAsyncCall(ask, readFirstString(hookPayload, ['tool_use_id', 'call_id'])))
    }
  } else if (eventName === 'SessionStart') {
    asks.delete(paneKey)
  } else if (eventName === 'UserPromptSubmit') {
    const ask = asks.get(paneKey)
    store(ask ? remainingCodexAsyncAsk(ask, readString(hookPayload, 'prompt') ?? promptText) : null)
  } else if (eventName === 'Stop') {
    const ask = asks.get(paneKey)
    const path = transcriptPathOf(hookPayload)
    const from = ask && path ? codexAsyncAskTranscriptStart(ask, path) : null
    if (ask && path && from !== null) {
      store(remainingAfterCodexTranscript(ask, path, readCodexUserMessagesSince(path, from)))
    }
  }
}
