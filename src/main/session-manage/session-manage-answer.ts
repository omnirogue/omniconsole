import type { ConversationSource } from '../../shared/conversation-source'
import {
  sessionManageActorTitle,
  type SessionManageActor,
  type SessionManageAnswerResult,
  type SessionManageEntry,
  type SessionPromptAnswer
} from '../../shared/session-manage-types'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import { isSelfTarget } from './session-manage-caller'
import { remoteExecutionRefusal } from './session-manage-locality'
import { positiveStateBasis, positivelyAwayFromPrompt } from './session-answer-departure'
import type { SessionAnswerLock } from './session-manage-answer-lock'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import type { SessionPrompt } from './session-prompt'
import { assertUnattendedPolicy } from './session-manage-unattended'
import { selectSessionAnswer } from './session-answer-selection'
export { selectSessionAnswer } from './session-answer-selection'

export { withSessionAnswerLock, type SessionAnswerLock } from './session-manage-answer-lock'
export { answerHardStop } from './session-manage-answer-hard-stops'

export type SessionAnswerReading = {
  entry: SessionManageEntry
  source: ConversationSource | null
  prompt?: SessionPrompt
  /** The pid proof that the row's agent holds its terminal now; required for a PTY answer. */
  agentProcess?: TerminalAgentProcessProof | null
}

export type SessionAnswerSelection = { n?: number; label: string; value: string }

/** `unconfirmed` always says why: an answer typed but not seen to land is never silent. */
export type SessionAnswerDelivery =
  | { status: 'recorded' | 'confirmed' }
  | { status: 'unconfirmed'; reason: string }

export type SessionAnswerDeps = {
  read(): Promise<SessionAnswerReading>
  /** Uses the same repeated positive departure checks as post-write confirmation. */
  confirmDeparture?(): Promise<boolean>
  validate?(prompt: SessionPrompt, chosen: SessionAnswerSelection): void
  /**
   * Proves, before anything changes, that the write target still holds: for a PTY answer the
   * agent process in `agentProcess` still owns the terminal's foreground. Throws to refuse.
   */
  preflight?(
    prompt: SessionPrompt,
    agentProcess: TerminalAgentProcessProof | null,
    chosen: SessionAnswerSelection
  ): Promise<void>
  /**
   * Reads the target again, last thing before anything changes, and refuses unless it still shows
   * exactly this prompt (identity, options and delivery) held by this agent process.
   */
  recheck(
    prompt: SessionPrompt,
    actor: SessionManageActor,
    agentProcess: TerminalAgentProcessProof | null
  ): Promise<void>
  stopKeepGoing(source: ConversationSource, detail: string): boolean
  /**
   * Sends the answer. A `SessionManageRefusal` means nothing was sent; any other error means a
   * write may have happened and its outcome is unknown.
   */
  deliver(
    prompt: SessionPrompt,
    chosen: SessionAnswerSelection,
    actor: SessionManageActor,
    agentProcess: TerminalAgentProcessProof | null
  ): Promise<SessionAnswerDelivery>
}

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing was sent.`)
}

export function requireExpectedPrompt(
  reading: SessionAnswerReading,
  actor: SessionManageActor,
  expect: string
): SessionPrompt {
  const { entry, source, prompt } = reading
  if (isSelfTarget(actor, entry.paneKey)) {
    refuse('A session cannot answer itself.')
  }
  // Why first, and for --deny and dry runs too: an SSH or paired host's process is that host's.
  const remote = remoteExecutionRefusal(entry, 'answer')
  if (remote) {
    throw new SessionManageRefusal(remote)
  }
  if (!source || entry.verdict !== 'live' || entry.state === 'unknown') {
    refuse('The target is unknown, exited or unverifiable.')
  }
  if (entry.state !== 'awaiting-user') {
    refuse('The target is not awaiting-user.')
  }
  if (!positiveStateBasis(entry.stateBasis)) {
    refuse(
      'The target is not proven to be waiting on a prompt now (no fresh report, title, screen or chat-host evidence).'
    )
  }
  if (!prompt) {
    refuse('The current prompt cannot be read reliably; answer it in its own session.')
  }
  if (prompt.ask.fingerprint !== expect) {
    refuse('Prompt fingerprint mismatch; list the sessions again and review the current prompt.')
  }
  const { delivery } = prompt
  if (delivery.kind === 'unavailable') {
    refuse(delivery.reason)
  }
  if (delivery.kind === 'structured' && (entry.kind !== 'chat' || source.kind !== 'structured')) {
    refuse('The prompt does not belong to this chat session.')
  }
  if (delivery.kind === 'pty' || delivery.kind === 'message') {
    // Why process proof: the answer is typed into the terminal, so only its agent may hold it.
    const proof = reading.agentProcess ?? null
    if (
      entry.kind !== 'terminal' ||
      source.kind !== 'pty' ||
      entry.agentForeground !== true ||
      !proof ||
      proof.ptyId !== delivery.ptyId ||
      // Why Codex: only Codex asks async questions, and only it takes this message as an answer.
      (delivery.kind === 'message' && proof.agent !== 'codex')
    ) {
      refuse(
        "The target's agent could not be proven to hold its terminal (by process id, start time and terminal), so no keystroke may reach it; answer it in its own session."
      )
    }
  }
  return prompt
}

export async function answerSession(
  deps: SessionAnswerDeps,
  input: {
    actor: SessionManageActor
    expect: string
    answer: SessionPromptAnswer
    dryRun: boolean
    lock: SessionAnswerLock
  }
): Promise<SessionManageAnswerResult> {
  // Why: a question put to the person is the person's; the steward only ever reports it.
  assertUnattendedPolicy(input.actor, 'answer')
  const reading = await deps.read()
  input.lock.bindPrompt(reading.prompt)
  if (
    !input.dryRun &&
    input.lock.uncertain &&
    !reading.prompt &&
    positivelyAwayFromPrompt(reading.entry) &&
    (await deps.confirmDeparture?.())
  ) {
    input.lock.leftPrompt()
  }
  const prompt = requireExpectedPrompt(reading, input.actor, input.expect)
  input.lock.admit()
  const chosen = selectSessionAnswer(prompt, input.answer, input.actor, reading.entry)
  deps.validate?.(prompt, chosen)
  const { entry } = reading
  const agentProcess =
    prompt.delivery.kind === 'pty' || prompt.delivery.kind === 'message'
      ? (reading.agentProcess ?? null)
      : null
  const base = {
    action: 'answer' as const,
    dryRun: input.dryRun,
    actor: input.actor,
    target: { paneKey: entry.paneKey, title: entry.title },
    ask: prompt.ask,
    commandText: [...prompt.commandText],
    chosen: { ...(chosen.n ? { n: chosen.n } : {}), label: chosen.label, value: chosen.value }
  }
  if (input.dryRun) {
    return {
      ...base,
      delivery: 'dry-run',
      keepGoingStopped: entry.keepGoing,
      summary: `Would answer “${entry.title}”: ${chosen.label} (dry run: nothing changed).`
    }
  }
  await deps.preflight?.(prompt, agentProcess, chosen)
  // Why before Keep going changes: a prompt answered or replaced meanwhile refuses with nothing done.
  await deps.recheck(prompt, input.actor, agentProcess)
  // Persist before dispatch: a crash after writing must never erase the pending answer.
  input.lock.markUncertain({
    ...base,
    chosen,
    promptDelivery: prompt.delivery,
    keepGoing: entry.keepGoing
  })
  const stopped = deps.stopKeepGoing(
    reading.source!,
    `${sessionManageActorTitle(input.actor)} answered this conversation's prompt.`
  )
  const partialAudit = (delivery: 'not-sent' | 'unknown') => ({
    before: { ask: prompt.ask, commandText: prompt.commandText, keepGoing: entry.keepGoing },
    after: { chosen, delivery, keepGoing: stopped ? false : entry.keepGoing }
  })
  let outcome: SessionAnswerDelivery
  try {
    outcome = await deps.deliver(prompt, chosen, input.actor, agentProcess)
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      // This exception is reserved for a positive no-write result from the delivery path.
      try {
        input.lock.leftPrompt()
      } catch (clearError) {
        throw new SessionManagePartialError(
          `${error.message} Its pending answer marker could not be cleared: ${String(clearError)}`,
          stopped
            ? 'Keep going was turned off; the pending marker remains'
            : 'the pending marker remains',
          partialAudit('not-sent')
        )
      }
      // Nothing was sent, but Keep going already changed: partial, and audited as such.
      if (stopped) {
        throw new SessionManagePartialError(
          error.message,
          'its Keep going was turned off',
          partialAudit('not-sent')
        )
      }
      throw error
    }
    // Past a refusal the answer may have reached the prompt: audited as partly applied, never a
    // normal result, and this prompt stays closed to another answer until it is read again.
    const detail = error instanceof Error ? error.message : String(error)
    throw new SessionManagePartialError(
      `${detail} The answer “${chosen.label}” may already have reached “${entry.title}”; inspect it before answering again.`,
      stopped
        ? 'its Keep going was turned off, and the answer may have been sent'
        : 'the answer may have been sent',
      partialAudit('unknown')
    )
  }
  let pendingWarning = ''
  if (outcome.status === 'confirmed') {
    try {
      input.lock.leftPrompt()
    } catch (error) {
      pendingWarning = ` Its pending marker could not be cleared; further answers remain blocked: ${String(error)}`
    }
  }
  return {
    ...base,
    delivery: outcome.status,
    keepGoingStopped: stopped,
    summary:
      outcome.status === 'unconfirmed'
        ? `Answer attempted for “${entry.title}”: ${chosen.label}; prompt exit was not confirmed: ${outcome.reason}. Inspect the session before retrying.`
        : outcome.status === 'recorded'
          ? `Recorded an answer for “${entry.title}”: ${chosen.label}. Provider delivery is not confirmed.`
          : `Answered for “${entry.title}”: ${chosen.label}.${pendingWarning}`
  }
}
