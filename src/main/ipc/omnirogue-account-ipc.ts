import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { OmniRogueAccountState } from '../../shared/omnirogue-account'
import { getSharedOmniRogueAccountLease } from '../omnirogue-account/omnirogue-account-lease'
import {
  runOmniRogueDoctor,
  type OmniRogueDoctorResult
} from '../omnirogue-account/omnirogue-doctor'
import type { Store } from '../persistence'
import { ROOM_CALLBACK } from '../rooms/room-credential-store'

const DEFAULT_OMNIROGUE_FRONTEND_ORIGIN = 'https://omnirogue.com'

export function broadcastOmniRogueAccountStatus(state: OmniRogueAccountState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('omnirogue:account:status-changed', state)
    }
  }
}

let deepLinkRegistered = false

function registerDeepLinkForwarding(): void {
  if (deepLinkRegistered || typeof app?.on !== 'function') {
    return
  }
  deepLinkRegistered = true
  const handleCallbackUrl = (url: string): void => {
    if (!url.startsWith(`${ROOM_CALLBACK}?`)) {
      return
    }
    void getSharedOmniRogueAccountLease()
      .acceptCallback(url)
      .then((state) => broadcastOmniRogueAccountStatus(state))
      .catch(() => undefined)
  }

  app.on('open-url', (_event, url) => {
    handleCallbackUrl(url)
  })
  app.on('second-instance', (_event, argv) => {
    const match = argv.find((arg) => arg.startsWith(`${ROOM_CALLBACK}?`))
    if (match) {
      handleCallbackUrl(match)
    }
  })
}

export function resolveOmniRogueSignupUrl(frontendOrigin?: string): string {
  const base = (frontendOrigin ?? DEFAULT_OMNIROGUE_FRONTEND_ORIGIN).replace(/\/+$/, '')
  return `${base}/signup`
}

export function registerOmniRogueAccountIpc(store: Store): void {
  const openExternalUrl = async (url: string): Promise<void> => {
    await shell.openExternal(url)
  }
  const lease = getSharedOmniRogueAccountLease()
  lease.setOpenBrowser(openExternalUrl)
  registerDeepLinkForwarding()

  const handleStatus = async (): Promise<OmniRogueAccountState> => lease.status()
  const handleLink = async (): Promise<OmniRogueAccountState> => {
    const state = await lease.link(openExternalUrl)
    broadcastOmniRogueAccountStatus(state)
    return state
  }
  const handleUnlink = async (): Promise<OmniRogueAccountState> => {
    const state = await lease.unlink()
    broadcastOmniRogueAccountStatus(state)
    return state
  }
  const handleAcceptCallback = async (
    _event: unknown,
    rawUrl: unknown
  ): Promise<OmniRogueAccountState> => {
    if (typeof rawUrl !== 'string') {
      return lease.status()
    }
    const state = await lease.acceptCallback(rawUrl)
    broadcastOmniRogueAccountStatus(state)
    return state
  }
  const handleOpenSignup = async (): Promise<{ url: string }> => {
    const currentStatus = await lease.status()
    const url = resolveOmniRogueSignupUrl(currentStatus.frontendOrigin)
    await openExternalUrl(url)
    return { url }
  }
  const handleRunDoctor = async (): Promise<OmniRogueDoctorResult> =>
    runOmniRogueDoctor({
      account: lease,
      billingMode:
        store.getSettings().primaryAi?.billing === 'omnirogue-credits'
          ? 'omnirogue-credits'
          : 'own-login'
    })

  for (const channel of ['omnirogue:account:status', 'omnirogue:account:get-status']) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handleStatus)
  }

  for (const channel of ['omnirogue:account:link', 'omnirogue:account:start-connect']) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handleLink)
  }

  for (const channel of ['omnirogue:account:unlink', 'omnirogue:account:disconnect']) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handleUnlink)
  }

  ipcMain.removeHandler('omnirogue:account:accept-callback')
  ipcMain.handle('omnirogue:account:accept-callback', handleAcceptCallback)

  ipcMain.removeHandler('omnirogue:account:open-signup')
  ipcMain.handle('omnirogue:account:open-signup', handleOpenSignup)

  ipcMain.removeHandler('omnirogue:account:runDoctor')
  ipcMain.handle('omnirogue:account:runDoctor', handleRunDoctor)
}

