// The effects behind send / cancel / respond / setOption.
//
// Admission (lease, fence, idempotency) has already passed by the time anything
// here runs; these functions own only the journal writes and the adapter call,
// in that order. Journal first is deliberate: a crash between the two leaves a
// row the next attach settles as `unknown`, whereas the reverse would lose a
// turn the provider already accepted.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { isTextBlock } from '../../../shared/native-chat-types'
import type {
  AgentSessionCancelResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { hubBoundAgentSessionSubmission } from './structured-agent-session-hub-prompt'
import { outcomeBoundAgentSessionSubmission } from './structured-agent-session-outcome-prompt'
export { performSetOption } from './structured-agent-session-turns-options'
export { performPrompt } from './structured-agent-session-turns-prompt'

export type AgentSessionTurnContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  hubTaskId?: string
  userSourceAuthority?: true
  persistedOptions?: Readonly<Record<string, string>>
  persistOptions: (options: Readonly<Record<string, string>>) => Promise<void>
  /** Opaque client identity recorded as the resolver of a prompt. */
  resolvedBy: string
  publish: () => void
  now: () => number
}

export type TurnOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; refusal: AgentSessionWireRefusal }

function invalid(message: string): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles
 *  as `unknown` rather than as a rejection. */
async function dispatchSafely(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  body: AgentJournalMessageItem
): Promise<AgentSessionDispatchOutcome> {
  try {
    return await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      fence: ctx.fence
    })
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function appendStatus(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  text: string
): Promise<void> {
  await ctx.journal.appendItem(
    { provider: 'omni', clientMessageId },
    { kind: 'status', text },
    { fence: ctx.fence }
  )
  ctx.publish()
}

export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    retryUnknown?: true
    beforeDispatch?: () => void
  }
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (existing && existing.payloadFingerprint !== input.payloadFingerprint) {
    return invalid(`Message id ${input.clientMessageId} was already used for another send.`)
  }
  if (existing && !(input.retryUnknown && existing.dispatchState === 'unknown')) {
    return {
      ok: true,
      value: { clientMessageId: input.clientMessageId, submission: existing }
    }
  }
  const sourcePrompt =
    ctx.userSourceAuthority && input.body.role === 'user'
      ? input.body.blocks
          .filter(isTextBlock)
          .map((block) => block.text)
          .join('\n')
      : null
  const body = outcomeBoundAgentSessionSubmission(
    hubBoundAgentSessionSubmission({
      body: input.body,
      hubTaskId: ctx.hubTaskId,
      clientMessageId: input.clientMessageId,
      submissions: ctx.journal.submissions()
    }),
    sourcePrompt
  )
  if (!(input.retryUnknown && existing?.dispatchState === 'unknown')) {
    await ctx.journal.appendSubmission({
      clientMessageId: input.clientMessageId,
      payloadFingerprint: input.payloadFingerprint,
      body,
      sourcePrompt,
      fence: ctx.fence
    })
  }
  // Guard after durable admission, without another await or status publication before dispatch.
  let outcome: AgentSessionDispatchOutcome | undefined
  try {
    input.beforeDispatch?.()
  } catch (error) {
    outcome = { state: 'rejected', reason: error instanceof Error ? error.message : String(error) }
  }
  outcome ??= await dispatchSafely(ctx, input.clientMessageId, body)
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId: input.clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            fence: ctx.fence
          }
        : {
            clientMessageId: input.clientMessageId,
            state: outcome.state,
            reason: outcome.reason,
            fence: ctx.fence
          }
    )
  } catch (error) {
    // A failed resolution must not strand a pending row; an unknown result is
    // explicitly replayable.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId: input.clientMessageId,
        state: 'unknown',
        reason: 'dispatch_result_persistence_failed',
        fence: ctx.fence,
        recovered: true
      })
    } catch {
      // Nothing further to record; the pending row is settled on the next attach.
    }
    ctx.publish()
    throw error
  }
  ctx.publish()

  const submission = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  return { ok: true, value: { clientMessageId: input.clientMessageId, submission } }
}

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: {
    clientOperationId: string
    turnId: string
    scope?: 'background-tasks'
  }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  let cancelled = false
  let note = 'Cancellation requested.'
  try {
    cancelled = input.scope
      ? (
          await ctx.adapter.stopBackgroundTasks?.({
            sessionId: ctx.sessionId,
            fence: ctx.fence
          })
        )?.cancelled === true
      : (
          await ctx.adapter.cancelTurn({
            sessionId: ctx.sessionId,
            turnId: input.turnId,
            fence: ctx.fence
          })
        ).cancelled
    if (!cancelled) {
      note = 'The provider had already finished this turn.'
    }
  } catch (error) {
    note = `Cancellation was not confirmed: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  if (input.scope) {
    return { ok: true, value: { turnId: input.turnId, cancelled } }
  }
  // Keyed by the operation id so a replayed cancel upserts one item, not two.
  await appendStatus(ctx, input.clientOperationId, note)
  return { ok: true, value: { turnId: input.turnId, cancelled } }
}
