import { randomUUID } from 'node:crypto'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { conversationSourceRowKey } from '../../../../shared/conversation-source'
import type { SessionManageActor } from '../../../../shared/session-manage-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  requireExpectedPrompt,
  type SessionAnswerDeps,
  type SessionAnswerReading,
  type SessionAnswerSelection
} from '../../../session-manage/session-manage-answer'
import { SessionManageRefusal } from '../../../session-manage/session-manage-deliver'
import { toSessionManageEntry } from '../../../session-manage/session-manage-inventory'
import { observeSession } from '../../../session-manage/session-manage-observe'
import { runtimeDeliveryDeps } from '../../../session-manage/session-manage-runtime-actions'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import type { SessionPrompt } from '../../../session-manage/session-prompt'
import { bindSessionPrompt, sessionPromptBinding } from '../../session-prompt-binding'
import {
  closeWriteFence,
  isWriteFenceOpen,
  noteWriteFencePty,
  openWriteFence,
  registerWriteFenceInvalidator
} from '../../conversation-write-fence'
import type { TerminalAgentProcessProof } from '../../terminal-agent-process'
import { confirmSessionPromptExit } from '../../../session-manage/session-answer-confirmation'
import { readSessionAnswerDeparture } from '../../../session-manage/session-answer-departure'
import type { RpcContext } from '../core'
import { answerWriteRefusal, sameAgentProcess } from './session-manage-answer-write'
import type { PreparedSessionAction } from './session-manage-support'
import { asyncQuestionAnswerSteps } from './session-manage-answer-async'
import { respondToApproval, respondToQuestion } from './structured-agent-session-responses'
import { RespondParams } from './structured-agent-session-schemas'
import { sessionAnswerKeystrokes } from './session-answer-keystrokes'
export { sessionAnswerKeystrokes } from './session-answer-keystrokes'

function structuredResponseParams(prompt: SessionPrompt, chosen: SessionAnswerSelection) {
  const delivery = prompt.delivery
  if (delivery.kind !== 'structured') {
    throw new Error('Expected a structured prompt.')
  }
  const kind = prompt.ask.kind === 'permission' ? 'approval' : 'question'
  const fields = {
    itemId: delivery.itemId,
    expectedRevision: delivery.revision,
    optionId: chosen.value
  }
  const params = RespondParams.parse({
    ...fields,
    envelope: {
      sessionId: delivery.sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
      expectedRuntimeFence: delivery.fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: `agentSession.respondTo:${kind}`,
        sessionId: delivery.sessionId,
        fields
      })
    }
  })
  return { kind, params }
}

async function respondStructured(
  context: RpcContext,
  prompt: SessionPrompt,
  chosen: SessionAnswerSelection,
  actor: SessionManageActor
): Promise<{ status: 'recorded' }> {
  const { kind, params } = structuredResponseParams(prompt, chosen)
  const respond = kind === 'approval' ? respondToApproval : respondToQuestion
  const result = await respond(context, params, actor)
  if (!result.ok) {
    throw new SessionManageRefusal(`The prompt response was refused: ${result.refusal.message}`)
  }
  // The provider path journals answers even when its provider cannot confirm delivery.
  return { status: 'recorded' }
}

const NOT_SENT = 'Nothing was sent.'
const asRefusal = (error: unknown): SessionManageRefusal =>
  error instanceof SessionManageRefusal
    ? error
    : new SessionManageRefusal(
        `${error instanceof Error ? error.message : 'The write was refused.'} ${NOT_SENT}`
      )

export function runtimeSessionAnswerDeps(
  context: Pick<RpcContext, 'runtime' | 'signal'>,
  prepared: Pick<PreparedSessionAction, 'row' | 'entry' | 'source'>,
  ownerGuard?: {
    validateReading(reading: SessionAnswerReading): void
    stillCurrent(): boolean
  }
): SessionAnswerDeps {
  const { runtime } = context
  const sources = createRuntimeObserveSources(runtime)
  const readCurrent: SessionAnswerDeps['read'] = async () => {
    const observed = await observeSession(prepared.row, sources)
    if (observed.terminal !== prepared.entry.terminal) {
      throw new SessionManageRefusal(
        'The target terminal changed. Nothing was sent; list the sessions again.'
      )
    }
    return {
      entry: toSessionManageEntry(observed),
      source: observed.source,
      prompt: observed.prompt,
      agentProcess: observed.agentProcess
    }
  }
  const read: SessionAnswerDeps['read'] = async () => {
    const reading = await readCurrent()
    ownerGuard?.validateReading(reading)
    return reading
  }
  const recheck = async (
    prompt: SessionPrompt,
    actor: SessionManageActor,
    bound: TerminalAgentProcessProof | null
  ): Promise<SessionAnswerReading> => {
    context.signal?.throwIfAborted()
    const reading = await read()
    const current = requireExpectedPrompt(reading, actor, prompt.ask.fingerprint)
    if (JSON.stringify(current) !== JSON.stringify(prompt)) {
      throw new SessionManageRefusal(
        'The prompt identity, options or screen changed. Nothing was sent; list the sessions again.'
      )
    }
    if (bound && (!reading.agentProcess || !sameAgentProcess(reading.agentProcess, bound))) {
      throw new SessionManageRefusal(
        'A different process now holds the terminal than the agent this answer was for. Nothing was sent.'
      )
    }
    return reading
  }
  const confirmDeparture = () =>
    confirmSessionPromptExit(() => readSessionAnswerDeparture(readCurrent, runtime, prepared.row))
  /** The queue's own write-boundary proof (`conversation-delivery.ts` `verifyWrite`). */
  const verifyWrite = async (proof: TerminalAgentProcessProof, ptyId: string) => {
    try {
      await runtime.assertTerminalAgentProcess(proof, ptyId)
    } catch (error) {
      throw asRefusal(error)
    }
  }
  const asyncAnswer = asyncQuestionAnswerSteps(
    runtime,
    prepared.row.paneKey ?? '',
    ownerGuard?.stillCurrent
  )
  return {
    read,
    confirmDeparture: async () => (await confirmDeparture()).status === 'confirmed',
    validate: (prompt, chosen) => {
      if (prompt.delivery.kind === 'structured') {
        structuredResponseParams(prompt, chosen)
      }
      if (prompt.delivery.kind === 'pty') {
        sessionAnswerKeystrokes(chosen.value)
      }
      if (prompt.delivery.kind === 'message') {
        asyncAnswer.validate(chosen)
      }
    },
    preflight: async (prompt, agentProcess, chosen) => {
      if (prompt.delivery.kind === 'message') {
        await asyncAnswer.preflight(prompt, agentProcess, chosen)
        return
      }
      if (prompt.delivery.kind !== 'pty') {
        return
      }
      if (!agentProcess || agentProcess.ptyId !== prompt.delivery.ptyId) {
        throw new SessionManageRefusal(
          "The target's agent process is not proven to hold its terminal. Nothing was sent."
        )
      }
      await verifyWrite(agentProcess, prompt.delivery.ptyId)
    },
    recheck: async (prompt, actor, agentProcess) => {
      const typed = prompt.delivery.kind === 'pty' || prompt.delivery.kind === 'message'
      await recheck(prompt, actor, typed ? agentProcess : null)
    },
    stopKeepGoing: runtimeDeliveryDeps(runtime).stopKeepGoing,
    async deliver(prompt, chosen, actor, agentProcess) {
      const delivery = prompt.delivery
      if (delivery.kind === 'structured') {
        await recheck(prompt, actor, null)
        return respondStructured(context, prompt, chosen, actor)
      }
      if (delivery.kind === 'unavailable') {
        throw new SessionManageRefusal(delivery.reason)
      }
      if (delivery.kind === 'message') {
        return asyncAnswer.deliver(chosen, context.signal)
      }
      const source = prepared.source
      if (!agentProcess || agentProcess.ptyId !== delivery.ptyId || source?.kind !== 'pty') {
        throw new SessionManageRefusal(
          "The target's agent process is not proven to hold its terminal. Nothing was sent."
        )
      }
      const keys = sessionAnswerKeystrokes(chosen.value)
      // Bound like a queued relay prompt: this answer goes only to this exact agent process.
      const rowKey = conversationSourceRowKey(source)
      const bindingId = `session-answer:${randomUUID()}`
      const release = bindSessionPrompt(rowKey, bindingId, { receiver: agentProcess })
      const initialHook = runtime.getFreshAgentHookStatusForHandle(delivery.handle)
      const hookSnapshot = JSON.stringify(initialHook)
      const token = openWriteFence(
        source,
        () =>
          (ownerGuard?.stillCurrent() ?? true) &&
          sessionPromptBinding(rowKey, bindingId)?.receiver === agentProcess &&
          JSON.stringify(runtime.getFreshAgentHookStatusForHandle(delivery.handle)) === hookSnapshot
      )
      const fence = {
        token,
        isRevoked: () => !(ownerGuard?.stillCurrent() ?? true) || !isWriteFenceOpen(token),
        onClose: (invalidate: () => void) => registerWriteFenceInvalidator(token, invalidate)
      }
      const cancel = () => closeWriteFence(token)
      context.signal?.addEventListener('abort', cancel, { once: true })
      let reserved = 0
      // One passing process proof licenses exactly one key reservation.
      let provenFor: { ptyId: string; proof: TerminalAgentProcessProof } | null = null
      let hookRequired = initialHook !== null
      try {
        for (const key of keys) {
          const guard = {
            // Before EVERY write: the bound agent process, then the prompt it is answering.
            beforeWrite: async (ptyId: string) => {
              provenFor = null
              const bound = sessionPromptBinding(rowKey, bindingId)?.receiver
              if (!bound || ptyId !== delivery.ptyId || ptyId !== bound.ptyId) {
                throw new SessionManageRefusal('The terminal was replaced. Nothing was sent.')
              }
              await verifyWrite(bound, ptyId)
              const current = await recheck(prompt, actor, bound)
              // An agent that reported through its hook must still report waiting at the write.
              hookRequired ||=
                current.entry.stateBasis === 'hook' ||
                runtime.getFreshAgentHookStatusForHandle(delivery.handle) !== null
              provenFor = { ptyId, proof: bound }
            },
            reserveWrite: (ptyId: string) => {
              const proven = provenFor
              provenFor = null
              context.signal?.throwIfAborted()
              if (ownerGuard && !ownerGuard.stillCurrent()) {
                throw new SessionManageRefusal(
                  'The displayed question owner changed. Nothing was sent.'
                )
              }
              const refusal = answerWriteRefusal({
                ptyId,
                delivery,
                pane: runtime.resolveTerminalPane(prepared.row.paneKey!, prepared.row.worktreeId),
                provenProcess: proven?.ptyId === ptyId ? proven.proof : null,
                boundProcess: sessionPromptBinding(rowKey, bindingId)?.receiver ?? null,
                expectedProcess: agentProcess,
                livenessVerdict: runtime.getTerminalLivenessVerdict(delivery.handle),
                hook: runtime.getFreshAgentHookStatusForHandle(delivery.handle),
                hookRequired
              })
              if (refusal) {
                throw new SessionManageRefusal(`${refusal} ${NOT_SENT}`)
              }
              reserved += 1
            }
          }
          await guard.beforeWrite(delivery.ptyId)
          guard.reserveWrite(delivery.ptyId)
          noteWriteFencePty(token, delivery.ptyId)
          const outcome = await runtime.sendGuardedSessionKey(
            delivery.handle,
            key,
            agentProcess,
            fence
          )
          if (outcome !== 'written') {
            if (!['refused', 'revoked', 'unsupported'].includes(outcome)) {
              throw new Error('The owning terminal could not confirm whether it wrote the answer.')
            }
            reserved = 0
            throw new SessionManageRefusal(
              `The owning terminal refused the answer (${outcome}). Nothing was sent.`
            )
          }
        }
      } catch (error) {
        if (reserved === 0) {
          throw asRefusal(error)
        }
        // A keystroke may already have landed: never a refusal ("nothing sent"), never retried.
        throw new Error(
          `The keystroke was reserved but its write did not complete: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        context.signal?.removeEventListener('abort', cancel)
        closeWriteFence(token)
        release()
      }
      return confirmDeparture()
    }
  }
}
