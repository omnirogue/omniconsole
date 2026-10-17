import type { SessionOutcomeService } from './session-outcome-service'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import { attachOutcomeToTask } from './session-outcome-task-ref'
import {
  captureConsoleWorkflowPerson,
  redactConsoleWorkflowMemory
} from '../backoffice/console-workflow-person'
import { attachConsoleSession, ingestConsoleSession } from '../backoffice/console-session-task'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import type { OutcomeTaskAttachmentAccess } from './session-outcome-task-ref'

/** Uses the same hub session attach operation as the task composer, without renderer state. */
export async function outcomeTaskAttachmentAccess(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): Promise<OutcomeTaskAttachmentAccess> {
  const captured = await captureConsoleWorkflowPerson()
  if (!captured.ok) {
    throw new Error(captured.error.message)
  }
  const person = captured.data
  if (
    chain.outcomeSet?.continuation.principal &&
    chain.outcomeSet.continuation.principal !== person.principal
  ) {
    throw new Error('Restore the original signed company/person before filing this outcome.')
  }
  async function post(taskId: string, endpoint: string, body: unknown) {
    if (!person.isCurrent()) {
      return { ok: false as const, reason: 'The signed-in person changed.' }
    }
    try {
      const response = await fetch(`${person.baseUrl}/api/team/tasks/${taskId}/${endpoint}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${person.bearer}` },
        body: JSON.stringify(body)
      })
      const data = await readFetchResponseJsonWithinLimit<unknown>(response, 2_097_152)
      if (!response.ok || (data && typeof data === 'object' && 'ok' in data && data.ok === false)) {
        return {
          ok: false as const,
          reason:
            JSON.stringify(redactConsoleWorkflowMemory(data)) ??
            `Hub refused ${endpoint} (HTTP ${response.status}).`
        }
      }
      if (!person.isCurrent()) {
        return { ok: false as const, reason: 'The signed-in person changed.' }
      }
      return { ok: true as const, data }
    } catch {
      return { ok: false as const, reason: `The hub ${endpoint} could not be confirmed.` }
    }
  }
  return {
    source: 'user',
    cardAccess: person,
    loadChain: (id) => runtime.listSessionChains().find((entry) => entry.id === id),
    persistence: runtime,
    poster: {
      now: Date.now,
      postNote: async (_access, taskId, note) => {
        const result = await post(taskId, 'comment', note)
        if (!result.ok) {
          return result
        }
        const id = (result.data as { id?: unknown } | null)?.id
        return typeof id === 'string' && id
          ? { ok: true, data: { id } }
          : { ok: false, reason: 'The hub did not confirm the stored note.' }
      },
      postEvidence: async (_access, taskId, evidence) => post(taskId, 'evidence', evidence),
      attachSessionToTask: async (taskId) => {
        if (!person.isCurrent()) {
          return { attached: false, errorMessage: 'The signed-in person changed.' }
        }
        const source = runtime.getSessionOutcomeTranscriptSource(chain)
        const session = await ingestConsoleSession({
          sessionRef: source?.kind === 'structured' ? source.sessionId : chain.sourcePaneKey,
          cwd: chain.workspacePath,
          provider: source?.agent ?? 'unknown',
          title: chain.outcomeSet?.outcomes[0]?.title ?? chain.id
        })
        if (!session.ok) {
          return {
            attached: false,
            errorCode: session.error.code,
            errorMessage: session.error.message
          }
        }
        if (!person.isCurrent()) {
          return { attached: false, errorMessage: 'The signed-in person changed.' }
        }
        const attached = await attachConsoleSession({ sessionId: session.data.sessionId, taskId })
        return attached.ok && person.isCurrent()
          ? { attached: true }
          : {
              attached: false,
              errorMessage: attached.ok ? 'The signed-in person changed.' : attached.error.message
            }
      }
    }
  }
}

export async function attachSessionOutcomeTask(
  service: SessionOutcomeService,
  id: string,
  outcomeId: string,
  taskId: string,
  expectedRevision: number
): Promise<SessionChain> {
  const { runtime } = service
  const chain = service.get(id)
  await assertSessionOutcomeExecutionScope(runtime, chain)
  if (chain.outcomeSet!.revision !== expectedRevision) {
    throw new Error('Outcome revision conflict.')
  }
  return attachOutcomeToTask(
    await service.taskAttachment(runtime, chain),
    chain.id,
    outcomeId,
    taskId
  )
}
