/**
 * The renderer's door into the host's per-session input queue.
 *
 * Chat sends and chain step launches hand over the WHOLE sequence (clear, body,
 * submit) as one item instead of writing bytes themselves, so their ordering,
 * idempotency and cancellation are decided in one place for the session.
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { getPtyIpc } from '../../pty-host-bindings'
import type { OrcaRuntimeService } from '../../../runtime/omni-runtime'
import type {
  SessionInputOrigin,
  SessionInputProgram,
  SessionInputReceipt,
  SessionInputStep,
  SessionInputSubmission
} from '../../../../shared/session-input-program'
import { isMainWindowPtyIpcEvent } from './write-input'
import {
  AGENT_QUESTION_ANSWER_CHANNEL,
  isAgentQuestionAnswerRequest,
  type AgentQuestionAnswerOutcome
} from '../../../../shared/agent-question-answer-contract'
import { answerAgentQuestionWithProof } from '../../../runtime/agent-question-message-answer'
import { agentHookServer } from '../../../agent-hooks/server'

const SESSION_INPUT_ORIGINS: readonly SessionInputOrigin[] = ['chat', 'chain', 'worker']

function isSessionInputStep(value: unknown): value is SessionInputStep {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const step = value as {
    kind?: unknown
    data?: unknown
    ms?: unknown
    afterMs?: unknown
    widenTo?: unknown
  }
  if (step.kind === 'write') {
    return typeof step.data === 'string'
  }
  if (step.kind === 'pause') {
    return typeof step.ms === 'number' && Number.isFinite(step.ms)
  }
  if (step.kind === 'clear-confirm') {
    return (
      typeof step.afterMs === 'number' &&
      Number.isFinite(step.afterMs) &&
      typeof step.widenTo === 'string'
    )
  }
  return false
}

function isSessionInputProgram(value: unknown): value is SessionInputProgram {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const steps = (value as { steps?: unknown }).steps
  return Array.isArray(steps) && steps.every(isSessionInputStep)
}

export function isSessionInputSubmissionPayload(value: unknown): value is SessionInputSubmission {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const payload = value as Partial<SessionInputSubmission>
  return (
    typeof payload.ptyId === 'string' &&
    payload.ptyId.length > 0 &&
    typeof payload.clientMessageId === 'string' &&
    payload.clientMessageId.length > 0 &&
    typeof payload.origin === 'string' &&
    SESSION_INPUT_ORIGINS.includes(payload.origin as SessionInputOrigin) &&
    typeof payload.body === 'string' &&
    (payload.force === undefined || typeof payload.force === 'boolean') &&
    isSessionInputProgram(payload.program)
  )
}

type SessionInputCancelPayload = {
  id: string
  clientMessageId?: string
  origin?: SessionInputOrigin
}

function isSessionInputCancelPayload(value: unknown): value is SessionInputCancelPayload {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const payload = value as Partial<SessionInputCancelPayload>
  return (
    typeof payload.id === 'string' &&
    payload.id.length > 0 &&
    (payload.clientMessageId === undefined || typeof payload.clientMessageId === 'string') &&
    (payload.origin === undefined || SESSION_INPUT_ORIGINS.includes(payload.origin))
  )
}

export function installPtySessionInputIpcHandlers(deps: {
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
}): void {
  const ipcMain = getPtyIpc()
  const { mainWindow, runtime } = deps
  const fromMainWindow = (event: IpcMainInvokeEvent): boolean =>
    isMainWindowPtyIpcEvent(event, mainWindow, mainWindow.webContents)

  ipcMain.handle(
    'pty:submitSessionInput',
    async (event, args: unknown): Promise<SessionInputReceipt> => {
      if (!fromMainWindow(event) || !isSessionInputSubmissionPayload(args)) {
        return {
          clientMessageId:
            typeof (args as { clientMessageId?: unknown })?.clientMessageId === 'string'
              ? (args as { clientMessageId: string }).clientMessageId
              : 'unknown',
          status: 'failed',
          errorCode: 'session_input_rejected'
        }
      }
      if (!runtime) {
        return {
          clientMessageId: args.clientMessageId,
          status: 'failed',
          errorCode: 'terminal_not_writable'
        }
      }
      return await runtime.submitSessionInput(args)
    }
  )

  ipcMain.handle(
    AGENT_QUESTION_ANSWER_CHANNEL,
    async (event, args: unknown): Promise<AgentQuestionAnswerOutcome> => {
      if (!fromMainWindow(event) || !isAgentQuestionAnswerRequest(args) || !runtime) {
        return {
          status: 'not-sent',
          reason: 'The answer could not be handed over. Nothing was sent.'
        }
      }
      return await answerAgentQuestionWithProof(runtime, args, (paneKey) => {
        agentHookServer.dropAsyncQuestion(paneKey)
      })
    }
  )

  ipcMain.handle('pty:cancelSessionInput', (event, args: unknown): boolean => {
    if (!fromMainWindow(event) || !isSessionInputCancelPayload(args) || !runtime) {
      return false
    }
    // Why this answers immediately: cancelling kills each matching item's writer
    // before returning, so by the time the caller sees `true` none of them can
    // put another byte into the session — a dead delivery still unwinding cannot.
    runtime.cancelSessionInput(args.id, {
      ...(args.clientMessageId !== undefined ? { clientMessageId: args.clientMessageId } : {}),
      ...(args.origin !== undefined ? { origin: args.origin } : {})
    })
    return true
  })
}
