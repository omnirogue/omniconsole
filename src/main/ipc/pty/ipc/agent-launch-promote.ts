import { getPtyIpc } from '../../pty-host-bindings'
import {
  cancelPtySpawnAgentLaunch,
  promotePtySpawnAgentLaunch
} from '../agent-launch-admission-gate'

export const PTY_PROMOTE_AGENT_LAUNCH_CHANNEL = 'pty:promoteAgentLaunch'
export const PTY_CANCEL_AGENT_LAUNCH_CHANNEL = 'pty:cancelAgentLaunch'

/** A person revealed a pane whose agent start still waits for an app-wide start slot: move it
 *  ahead of the background starts (the admission priority lane). The pane that asked for a start
 *  went away while it waited: drop it without using a slot. */
export function installPtyAgentLaunchPromoteIpcHandler(): void {
  const ipcMain = getPtyIpc()
  ipcMain.removeHandler(PTY_PROMOTE_AGENT_LAUNCH_CHANNEL)
  ipcMain.handle(
    PTY_PROMOTE_AGENT_LAUNCH_CHANNEL,
    async (_event, args: { key?: unknown } | undefined): Promise<boolean> =>
      promotePtySpawnAgentLaunch(args?.key)
  )
  ipcMain.removeHandler(PTY_CANCEL_AGENT_LAUNCH_CHANNEL)
  ipcMain.handle(
    PTY_CANCEL_AGENT_LAUNCH_CHANNEL,
    async (_event, args: { token?: unknown } | undefined): Promise<boolean> =>
      cancelPtySpawnAgentLaunch(args?.token)
  )
}
