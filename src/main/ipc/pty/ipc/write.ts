import { bumpPtyInput } from '../../../runtime/conversation-mutation-generation'
import type { BrowserWindow } from 'electron'
import { isTypedTerminalInput } from '../../../../shared/terminal-typed-input'
import { getPtyIpc } from '../../pty-host-bindings'
import type { OrcaRuntimeService } from '../../../runtime/omni-runtime'
import { createPtyWriteInput } from './write-input'
import {
  clearUnresolvedDraft,
  markUnresolvedDraft,
  terminalDraftRevision
} from '../../../runtime/terminal-unresolved-draft'
import { recordTerminalKeyboardSubmit } from '../../../session-prep/terminal-keyboard-submits'

export function installPtyWriteIpcHandlers(deps: {
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
  clearHiddenRendererResizeOutput: (id: string) => void
}): void {
  const ipcMain = getPtyIpc()
  const { mainWindow, runtime } = deps
  const {
    writePtyInput,
    writePtyInputAccepted,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  } = createPtyWriteInput(deps)

  const hostViewportClaimTails = new Map<string, Promise<boolean>>()
  const reconciledWrite = (
    args: { id: string; data: string },
    accepted: boolean | Promise<boolean>,
    revision: number
  ): boolean | Promise<boolean> => {
    const reconcile = (wrote: boolean): boolean => {
      if (wrote && args.data === '\r' && terminalDraftRevision(args.id) === revision) {
        clearUnresolvedDraft(args.id)
      }
      return wrote
    }
    return typeof accepted === 'boolean' ? reconcile(accepted) : accepted.then(reconcile)
  }
  const writePersonInput = (args: { id: string; data: string }, revision: number) => {
    return reconciledWrite(
      args,
      args.data === '\r' ? writePtyInputAccepted(args) : writePtyInput(args),
      revision
    )
  }

  ipcMain.on('pty:write', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents) || !isPtyWritePayload(args)) {
      return
    }
    if (isTypedTerminalInput(args.data)) {
      runtime?.invalidateConversationWritesForPty?.(args.id)
      bumpPtyInput(args.id)
      markUnresolvedDraft(args.id)
    }
    const revision = terminalDraftRevision(args.id)
    const claimTail = hostViewportClaimTails.get(args.id)
    if (claimTail) {
      void claimTail
        .then((claimed) => (claimed ? writePersonInput(args, revision) : false))
        .catch((error) => console.error('[pty] draft reconciliation failed', error))
      return
    }
    void Promise.resolve(writePersonInput(args, revision)).catch((error) =>
      console.error('[pty] draft reconciliation failed', error)
    )
  })
  ipcMain.on('pty:keyboardSubmit', (event, args: unknown) => {
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents) || !isKeyboardSubmit(args)) {
      return
    }
    recordTerminalKeyboardSubmit(args.id, args.line ?? '')
  })
  ipcMain.handle('pty:writeAccepted', (event, args: unknown): boolean | Promise<boolean> => {
    if (!isPtyWriteEventFromMainWindow(event, mainWindow.webContents) || !isPtyWritePayload(args)) {
      return false
    }
    if (isTypedTerminalInput(args.data)) {
      runtime?.invalidateConversationWritesForPty?.(args.id)
      bumpPtyInput(args.id)
      markUnresolvedDraft(args.id)
    }
    const claimTail = hostViewportClaimTails.get(args.id)
    const revision = terminalDraftRevision(args.id)
    return reconciledWrite(
      args,
      claimTail
        ? claimTail.then((claimed) => (claimed ? writePtyInputAccepted(args) : false))
        : writePtyInputAccepted(args),
      revision
    )
  })

  ipcMain.removeAllListeners('pty:claimViewport')
  ipcMain.on('pty:claimViewport', (event, args: unknown) => {
    if (
      !isPtyWriteEventFromMainWindow(event, mainWindow.webContents) ||
      !runtime ||
      !isPtyViewportClaimPayload(args)
    ) {
      return
    }
    const prior = hostViewportClaimTails.get(args.id)
    // Why: two panes can mirror one PTY — never let a later no-op claim replace the in-flight resize that the following host input must await.
    const claim = (
      prior
        ? prior.then(
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows),
            () => runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
          )
        : runtime.claimRemoteDesktopHost(args.id, args.cols, args.rows)
    ).catch((error) => {
      // Why: a failed claim silently discards every gated keystroke for this pane.
      console.error('[pty] remote desktop host claim failed; gated input will be discarded', error)
      return false
    })
    hostViewportClaimTails.set(args.id, claim)
    void claim.then(() => {
      if (hostViewportClaimTails.get(args.id) === claim) {
        hostViewportClaimTails.delete(args.id)
      }
    })
  })
}

const MAX_KEYBOARD_LINE_CHARS = 16_000

function isKeyboardSubmit(args: unknown): args is { id: string; line?: string } {
  if (typeof args !== 'object' || args === null) {
    return false
  }
  const { id, line } = args as { id?: unknown; line?: unknown }
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    (line === undefined || (typeof line === 'string' && line.length <= MAX_KEYBOARD_LINE_CHARS))
  )
}
