import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
import { launchAttributionSpawnFields } from './ipc-pty-spawn-launch-attribution'

type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

/** `incarnationId` names which lifetime of the returned id this spawn owns; absent when the
 *  execution host predates the field. It is deliberately NOT on `PtyConnectResult` — only the
 *  connect handshake needs it, to fence buffered state left by an earlier owner of the same id. */
export type IpcPtySpawnResponse = PtyConnectResult & {
  isReattach?: boolean
  incarnationId?: string
}

export async function spawnIpcPty(
  transportOptions: IpcPtyTransportOptions,
  connectOptions: PtyConnectOptions,
  admittedSessionId?: string,
  launchAdmissionToken?: string
): Promise<IpcPtySpawnResponse> {
  const {
    cwd,
    cwdFallback,
    env,
    envToDelete,
    command,
    commandDelivery,
    launchConfig,
    resumeProviderSession,
    launchToken,
    launchAgent,
    startupCommandDelivery,
    connectionId,
    worktreeId,
    tabId,
    leafId,
    shellOverride,
    projectRuntime,
    terminalColorQueryReplies,
    telemetry
  } = transportOptions
  const shouldSendLocalCwdFallback =
    cwdFallback === 'worktree' && !connectionId && !admittedSessionId
  return window.api.pty.spawn({
    interruptedRestore: connectOptions.interruptedRestore,
    cols: connectOptions.cols ?? 80,
    rows: connectOptions.rows ?? 24,
    cwd,
    ...(shouldSendLocalCwdFallback ? { cwdFallback } : {}),
    env: connectOptions.env ?? env,
    ...((connectOptions.envToDelete ?? envToDelete)
      ? { envToDelete: connectOptions.envToDelete ?? envToDelete }
      : {}),
    command: connectOptions.command ?? command,
    ...((connectOptions.commandDelivery ?? commandDelivery)
      ? { commandDelivery: connectOptions.commandDelivery ?? commandDelivery }
      : {}),
    ...((connectOptions.launchConfig ?? launchConfig)
      ? { launchConfig: connectOptions.launchConfig ?? launchConfig }
      : {}),
    ...((connectOptions.resumeProviderSession ?? resumeProviderSession)
      ? { resumeProviderSession: connectOptions.resumeProviderSession ?? resumeProviderSession }
      : {}),
    ...((connectOptions.launchToken ?? launchToken)
      ? { launchToken: connectOptions.launchToken ?? launchToken }
      : {}),
    ...((connectOptions.launchAgent ?? launchAgent)
      ? { launchAgent: connectOptions.launchAgent ?? launchAgent }
      : {}),
    ...((connectOptions.startupCommandDelivery ?? startupCommandDelivery)
      ? {
          startupCommandDelivery: connectOptions.startupCommandDelivery ?? startupCommandDelivery
        }
      : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(admittedSessionId ? { sessionId: admittedSessionId } : {}),
    ...(connectOptions.initiallyHidden ? { initiallyHidden: true } : {}),
    ...(connectOptions.launchPriority === 'person' ? { launchPriority: 'person' as const } : {}),
    ...(connectOptions.launchAdmissionKey
      ? { launchAdmissionKey: connectOptions.launchAdmissionKey }
      : {}),
    ...(launchAdmissionToken ? { launchAdmissionToken } : {}),
    worktreeId,
    ...(tabId ? { tabId } : {}),
    ...(leafId ? { leafId } : {}),
    ...(shellOverride ? { shellOverride } : {}),
    ...(projectRuntime ? { projectRuntime } : {}),
    ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
    ...(telemetry ? { telemetry } : {}),
    // Latency telemetry only: labels launch.process_spawn in main; never gates the spawn.
    ...launchAttributionSpawnFields(transportOptions.describeLaunch, {
      resumesAgentSession: Boolean(
        connectOptions.launchConfig ?? connectOptions.resumeProviderSession ?? resumeProviderSession
      ),
      hasStartupCommand: Boolean(connectOptions.command ?? command)
    })
  }) as Promise<IpcPtySpawnResponse>
}
