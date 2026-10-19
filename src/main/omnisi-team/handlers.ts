import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { OmnisiTeamService } from './service'

let trustedRenderer: number | null = null
export function setTrustedOmnisiTeamRenderer(id: number | null): void {
  trustedRenderer = id
}

export function registerOmnisiTeamHandlers(store: Store, runtime: OrcaRuntimeService): void {
  const service = new OmnisiTeamService(
    join(app.getPath('userData'), 'omnisi-team'),
    store,
    runtime
  )
  const handle = (name: string, work: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`omnisiTeam:${name}`, (event, ...args: unknown[]) => {
      if (
        trustedRenderer === null ||
        event.sender.id !== trustedRenderer ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error('Open OmniSI team in the desktop settings.')
      }
      return work(...args)
    })
  }
  handle('status', () => service.status())
  handle('enable', (enabled) => service.enable(enabled as boolean))
  handle('connect', (server, key) => service.connect(server as string, key as string))
  handle('disconnect', () => service.disconnect())
  void service.start()
  app.once('before-quit', () => {
    void service.stop()
  })
}
