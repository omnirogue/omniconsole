import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { OrcaRuntimeService } from '../../../runtime/omni-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { isPtyWriteUnavailableError } from '../../../providers/pty-write-unavailable-error'
import {
  agentSessionPtyWriteGate,
  type AgentSessionPtyWriteAdmittance
} from '../../../runtime/agent-session-pty-write-gate'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import { reportAgentSessionWriteRefusal } from '../agent-session-write-refusal-report'
import { extractOnlyTerminalQueryReplies } from '../../../../shared/terminal-query-reply'
import { isTerminalEmulatorReport } from '../../../../shared/prompt-queue-command'
import { ptyOwnership } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
import {
  interactiveOutputCharsByPty,
  lastInputAtByPty,
  visibleRendererPtys
} from '../delivery/visibility-state'

export function isMainWindowPtyIpcEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  mainWebContents: WebContents
): boolean {
  return (
    event.sender === mainWebContents &&
    !mainWindow.isDestroyed() &&
    !(typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed())
  )
}

export type PtyWritePayload = { id: string; data: string }
export type PtyViewportClaimPayload = { id: string; cols: number; rows: number }

export function createPtyWriteInput(deps: {
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
  clearHiddenRendererResizeOutput: (id: string) => void
}): {
  writePtyInput: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyInputAccepted: (args: PtyWritePayload) => boolean | Promise<boolean>
  isPtyWritePayload: (value: unknown) => value is PtyWritePayload
  isPtyViewportClaimPayload: (value: unknown) => value is PtyViewportClaimPayload
  isPtyWriteEventFromMainWindow: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    mainWebContents: WebContents
  ) => boolean
} {
  const { mainWindow, runtime, clearHiddenRendererResizeOutput } = deps

  const recordUserInput = ({ id, data }: PtyWritePayload): void => {
    if (!data || isTerminalEmulatorReport(data) || extractOnlyTerminalQueryReplies(data)) {
      return
    }
    runtime?.cancelConversationCapacityRecoveryForPty?.(id, 'New terminal input.')
    lastInputAtByPty.set(id, performance.now())
    interactiveOutputCharsByPty.set(id, 0)
    if (visibleRendererPtys.has(id)) {
      clearHiddenRendererResizeOutput(id)
    }
  }

  const reportUnavailablePtyWrite = (id: string, error: unknown): void => {
    if (
      !isPtyWriteUnavailableError(error) ||
      mainWindow.isDestroyed() ||
      (typeof mainWindow.webContents.isDestroyed === 'function' &&
        mainWindow.webContents.isDestroyed())
    ) {
      return
    }
    mainWindow.webContents.send('pty:writeUnavailable', { id })
  }

  /** Single lease check for every byte-entry point this module owns. */
  const admitAgentSessionPtyWrite = (id: string): AgentSessionPtyWriteAdmittance | null => {
    const admission = agentSessionPtyWriteGate.admit(id)
    if (admission.admitted) {
      return { sessionId: admission.sessionId, runtimeFence: admission.runtimeFence }
    }
    reportAgentSessionWriteRefusal(mainWindow, id, admission.refusal)
    return null
  }

  /** Re-check after a yield: the lease can move to another owner between chunks. */
  const readmitAgentSessionPtyWrite = (
    id: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): boolean => {
    const admission = agentSessionPtyWriteGate.readmit(id, admitted)
    if (admission.admitted) {
      return true
    }
    reportAgentSessionWriteRefusal(mainWindow, id, admission.refusal)
    return false
  }

  const writePtyProviderInputWithinLimit = (
    provider: IPtyProvider,
    id: string,
    data: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): boolean | Promise<boolean> => {
    const chunks = iterateTerminalInputChunks(data)
    const first = chunks.next()
    if (first.done) {
      return provider.write(id, data) !== false
    }
    const second = chunks.next()
    if (second.done) {
      return provider.write(id, first.value) !== false
    }
    return writePtyProviderInputChunks(provider, id, chunks, first.value, second.value, admitted)
  }

  const writePtyProviderInput = (
    provider: IPtyProvider,
    id: string,
    data: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): boolean | Promise<boolean> => {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge ? false : writePtyProviderInputWithinLimit(provider, id, data, admitted)
      }
      return tooLarge
        .then((result) => {
          if (result || !readmitAgentSessionPtyWrite(id, admitted)) {
            return false
          }
          return writePtyProviderInputWithinLimit(provider, id, data, admitted)
        })
        .catch((error) => {
          reportUnavailablePtyWrite(id, error)
          return false
        })
    } catch (error) {
      reportUnavailablePtyWrite(id, error)
      return false
    }
  }

  const writePtyProviderInputChunks = async (
    provider: IPtyProvider,
    id: string,
    chunks: Iterator<string>,
    firstChunk: string,
    secondChunk: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): Promise<boolean> => {
    try {
      let chunk: IteratorResult<string> = { done: false, value: firstChunk }
      let nextChunk: IteratorResult<string> = { done: false, value: secondChunk }
      let first = true
      while (!chunk.done) {
        if (!first && !readmitAgentSessionPtyWrite(id, admitted)) {
          return false
        }
        first = false
        if (provider.write(id, chunk.value) === false) {
          return false
        }
        if (!nextChunk.done) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        chunk = nextChunk
        nextChunk = chunks.next()
      }
      return true
    } catch (error) {
      reportUnavailablePtyWrite(id, error)
      return false
    }
  }

  const isPtyWritePayload = (value: unknown): value is PtyWritePayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { data?: unknown }).data === 'string'

  const isPtyViewportClaimPayload = (value: unknown): value is PtyViewportClaimPayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { cols?: unknown }).cols === 'number' &&
    Number.isFinite((value as { cols: number }).cols) &&
    typeof (value as { rows?: unknown }).rows === 'number' &&
    Number.isFinite((value as { rows: number }).rows) &&
    (value as { cols: number }).cols > 0 &&
    (value as { rows: number }).rows > 0

  const isPtyWriteEventFromMainWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    mainWebContents: WebContents
  ): boolean => isMainWindowPtyIpcEvent(event, mainWindow, mainWebContents)

  const writePtyInput = (args: PtyWritePayload): boolean | Promise<boolean> => {
    // Why: mobile-presence-lock defense-in-depth — the renderer's onData guard can let one keystroke slip during the state-flip lag, so catch it server-side. See docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const admitted = admitAgentSessionPtyWrite(args.id)
    if (!admitted) {
      return false
    }
    const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
    if (!provider) {
      return false
    }
    try {
      recordUserInput(args)
      return writePtyProviderInput(provider, args.id, args.data, admitted)
    } catch {
      return false
    }
  }

  const writePtyInputAccepted = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const admitted = admitAgentSessionPtyWrite(args.id)
    if (!admitted) {
      return false
    }
    const connectionId = ptyOwnership.get(args.id)
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty?.(args.id)) {
      // Why: after a relaunch a daemon session is unknown here until its pane re-attaches, so an
      // answer clicked in Work or Needs you for a terminal not opened since would be dropped.
      const attaching =
        connectionId == null
          ? runtime?.attachUnattachedLocalDaemonPtyForInput?.(args.id)
          : undefined
      return attaching
        ? attaching.then(
            (attached) =>
              attached &&
              readmitAgentSessionPtyWrite(args.id, admitted) &&
              tryGetProviderForPty(args.id)?.hasPty?.(args.id) === true
                ? writePtyInputAccepted(args)
                : false,
            () => false
          )
        : false
    }
    if (connectionId !== null) {
      const writeAccepted = provider.writeAccepted
      if (!writeAccepted) {
        return false
      }
      const isCurrent = (): boolean =>
        ptyOwnership.get(args.id) === connectionId &&
        tryGetProviderForPty(args.id) === provider &&
        runtime?.getDriver(args.id).kind !== 'mobile' &&
        readmitAgentSessionPtyWrite(args.id, admitted)
      const failed = (error: unknown): false => {
        reportUnavailablePtyWrite(args.id, error)
        return false
      }
      const deliver = (oversized: boolean): boolean | Promise<boolean> => {
        if (oversized || !isCurrent()) {
          return false
        }
        recordUserInput(args)
        return writeAccepted.call(provider, args.id, args.data, { isCurrent }).catch(failed)
      }
      try {
        const measured = isTerminalInputTooLargeWithDeferredMeasurement(args.data)
        return typeof measured === 'boolean'
          ? deliver(measured)
          : measured.then(deliver).catch(failed)
      } catch (error) {
        return failed(error)
      }
    }
    try {
      recordUserInput(args)
      // Socket flush is not owner acceptance. Native local writes are synchronous; a
      // transport-backed provider must implement the acknowledged contract.
      return provider.writeAccepted
        ? provider.writeAccepted(args.id, args.data, {
            isCurrent: () =>
              ptyOwnership.get(args.id) === connectionId &&
              runtime?.getDriver(args.id).kind !== 'mobile' &&
              tryGetProviderForPty(args.id) === provider &&
              readmitAgentSessionPtyWrite(args.id, admitted)
          })
        : provider.writeWithSettlement
          ? false
          : writePtyProviderInput(provider, args.id, args.data, admitted)
    } catch {
      return false
    }
  }

  return {
    writePtyInput,
    writePtyInputAccepted,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  }
}
