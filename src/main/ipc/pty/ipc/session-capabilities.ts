import { getPtyIpc } from '../../pty-host-bindings'
import { isValidPaneKey, registerPaneKeyTeardownListener } from '../pane/key-state'
import {
  forgetSessionCapabilitiesForPane,
  getSessionCapabilitiesForPane,
  recordSessionCapabilitiesForPane
} from '../../../session-capabilities/session-capability-registry'
import type { SessionCapabilities } from '../../../../shared/session-capabilities'

let unregisterTeardown: (() => void) | null = null

/** Shared by the renderer and runtime spawn commits; never awaited so a spawn cannot wait on it. */
export function recordSpawnSessionCapabilities(
  paneKey: string | null,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  args: { envToDelete?: string[]; connectionId?: string | null }
): void {
  void recordSessionCapabilitiesForPane(paneKey, {
    cwd,
    env,
    envToDelete: args.envToDelete,
    connectionId: args.connectionId
  })
}

export function installPtySessionCapabilitiesIpcHandler(): void {
  const ipcMain = getPtyIpc()
  ipcMain.handle(
    'pty:getSessionCapabilities',
    async (_event, args: { paneKey?: unknown }): Promise<SessionCapabilities | null> =>
      isValidPaneKey(args?.paneKey) ? getSessionCapabilitiesForPane(args.paneKey) : null
  )
  unregisterTeardown?.()
  unregisterTeardown = registerPaneKeyTeardownListener(forgetSessionCapabilitiesForPane)
}
