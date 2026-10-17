import {
  detectConversationalDispatchRequest,
  hasConversationalGoalPrefix
} from '../../shared/session-dispatch-intent'
import { SESSION_PREP_PARAMS, type SessionPrepBatchView } from '../../shared/session-prep-types'
import { formatSessionPrepEntry } from '../../shared/session-prep-context-format'
import { SESSION_PREP_TERMINAL_BATCH } from './session-prep-records'
import type { SessionPrepCheckedRequest } from './session-prep-requests'
import type {
  claimTerminalKeyboardSubmit,
  TerminalKeyboardSubmitClaim
} from './terminal-keyboard-submits'

/** Claude's UserPromptSubmit reply: the prompt never reaches the model; `reason` is shown to the person. */
export type PromptSubmitReply = { decision: 'block'; reason: string }

export type TerminalPromptEvent = {
  paneKey: string
  worktreeId?: string
  hasExplicitPrompt?: boolean
  providerPromptId?: string
  payload?: { prompt?: string }
  providerSession?: { id?: string; transcriptPath?: string }
}

type TerminalSessionPrepService = {
  requestFromTerminal(
    params: ReturnType<typeof SESSION_PREP_PARAMS.request.parse>
  ): Promise<SessionPrepCheckedRequest>
  listForSource(paneKey: string): SessionPrepBatchView[]
  cancel(batchId: string): Promise<SessionPrepBatchView>
}

export type TerminalInterceptDeps = {
  service: () => TerminalSessionPrepService | null
  automaticDispatch?: () => boolean
  ptyIdForPaneKey: (paneKey: string) => string | null
  worktreeIdForPaneKey: (paneKey: string) => string | null
  claimKeyboardSubmit: typeof claimTerminalKeyboardSubmit
  readContext: (transcriptPath: string) => Promise<string>
  /** The project a pane works in, as its project page counts it (`projectForPane`). */
  projectForPane?: (paneKey: string) => Promise<string | null>
}

// Why two proofs: an Enter just now covers a line edited with arrows; the typed-line match covers a
// message typed while the agent worked, which Claude delivers after its turn.
const KEYBOARD_SUBMIT_WINDOW_MS = 5_000
const TYPED_LINE_MAX_AGE_MS = 30 * 60_000
// Why: a prepared session's own first prompt names its batch; it must never re-enter session prep.
const PREPARED_PROMPT_MARK = 'Prepared by OmniConsole from your message'
const UNDO_PHRASE = /^(?:undo|cancel|stop)\s+(?:the\s+)?(?:sessions?|session prep)[.!]?$/i
const REPLY_HINT = 'Type "undo sessions" to stop, or start a message with "agent:" to send it here.'

function block(reason: string): PromptSubmitReply {
  return { decision: 'block', reason }
}

async function undoLatest(
  service: TerminalSessionPrepService,
  paneKey: string
): Promise<PromptSubmitReply> {
  const open = service
    .listForSource(paneKey)
    .find((batch) => !SESSION_PREP_TERMINAL_BATCH.has(batch.state))
  if (!open) {
    return block(
      'Session prep: nothing to undo — no sessions are being prepared from this terminal.'
    )
  }
  const after = await service.cancel(open.id)
  const launched = after.items.filter(
    (item) => item.state === 'launched' || item.state === 'launching'
  ).length
  return block(
    launched > 0
      ? `Session prep stopped. ${launched} session(s) had already launched and stay open.`
      : 'Session prep stopped. No sessions were launched.'
  )
}

/**
 * Diverts "create sessions for …" typed in a terminal Claude session to session prep, as the chat
 * composer does. Only the person's own submit counts (see terminal-keyboard-submits).
 */
export function createTerminalPromptInterceptor(deps: TerminalInterceptDeps) {
  const replies = new WeakMap<TerminalKeyboardSubmitClaim, Promise<PromptSubmitReply | null>>()
  return async (source: string, event: TerminalPromptEvent): Promise<PromptSubmitReply | null> => {
    const prompt = event.payload?.prompt?.trim() ?? ''
    if (source !== 'claude' || !prompt || prompt.includes(PREPARED_PROMPT_MARK)) {
      return null
    }
    const undo = UNDO_PHRASE.test(prompt)
    const automatic = deps.automaticDispatch?.() !== false && hasConversationalGoalPrefix(prompt)
    const candidate = undo ? null : detectConversationalDispatchRequest(prompt, '', automatic)
    const ptyId = undo || candidate ? deps.ptyIdForPaneKey(event.paneKey) : null
    const service = ptyId ? deps.service() : null
    if (!ptyId || !service) {
      return null
    }
    const claim = deps.claimKeyboardSubmit(
      ptyId,
      prompt,
      TYPED_LINE_MAX_AGE_MS,
      KEYBOARD_SUBMIT_WINDOW_MS,
      event.providerPromptId
        ? JSON.stringify([event.providerSession?.id, event.providerPromptId])
        : undefined
    )
    if (!claim) {
      return null
    }
    const previous = replies.get(claim)
    if (previous) {
      return previous
    }
    // Claim before reading context so concurrent hook delivery joins the same preparation.
    const reply = Promise.resolve().then(() => prepare(service))
    replies.set(claim, reply)
    return reply

    async function prepare(service: TerminalSessionPrepService): Promise<PromptSubmitReply | null> {
      if (undo) {
        return undoLatest(service, event.paneKey)
      }
      const worktreeId = event.worktreeId || deps.worktreeIdForPaneKey(event.paneKey)
      const transcriptPath = event.providerSession?.transcriptPath
      const readContext = transcriptPath
        ? await deps.readContext(transcriptPath).catch(() => null)
        : null
      const context = readContext ?? ''
      const detected = detectConversationalDispatchRequest(
        prompt,
        context.trim() === formatSessionPrepEntry('User', prompt)?.trim() ? '' : context,
        automatic && readContext !== null
      )
      if (!detected) {
        return null
      }
      // Why: a request typed in one of a project's threads files its sessions in that project.
      const defaultFolder = await deps.projectForPane?.(event.paneKey).catch(() => null)
      const params = SESSION_PREP_PARAMS.request.safeParse({
        text: detected.request,
        source: { worktreeId, paneKey: event.paneKey, agent: 'claude' },
        context,
        ...(defaultFolder ? { defaultFolder } : {})
      })
      if (!params.success) {
        return null
      }
      const result = await service.requestFromTerminal(params.data).catch(() => null)
      // Why let it through: a prep that never started must not swallow the person's message.
      if (!result || result.outcome === 'not-started') {
        return null
      }
      if (result.outcome === 'already-requested') {
        return block(
          `Session prep already has this message (${result.batchId}); nothing new was started and nothing was sent to this agent. ${REPLY_HINT}`
        )
      }
      const startedIn = result.startedIn
        ? ` This terminal's workspace is not available to session prep, so they start from ${result.startedIn}.`
        : ''
      return block(
        `Session prep is preparing sessions from your message (${result.batchId}); nothing was sent to this agent.${startedIn} ` +
          `They appear in the sidebar as they launch. ${REPLY_HINT}`
      )
    }
  }
}
