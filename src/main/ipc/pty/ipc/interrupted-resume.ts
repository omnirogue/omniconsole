import { watchInterruptedSessionReadiness } from '../../../agent-hooks/interrupted-session-readiness'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { readInterruptedStatus } from '../../../agent-hooks/interrupted-session-evidence'
import { join } from 'node:path'
import { makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { agentHookServer } from '../../../agent-hooks/server'
import {
  claimInterruptedTurn,
  createInterruptedSessionContinuation,
  INTERRUPTION_CONTINUATION
} from '../../../agent-hooks/interrupted-session-continuation'
import { getCanonicalUserDataPath } from '../../../persistence/loading-store/user-data-path'
import { getPtyIdForPaneKey, registerPaneKeyTeardownListener } from '../pane/key-state'
import { recordCrashBreadcrumb } from '../../../crash-reporting/crash-breadcrumb-store'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

export function prepareInterruptedResume(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  if (
    args.interruptedRestore !== true ||
    !args.resumeProviderSession ||
    !args.launchAgent ||
    typeof args.launchToken !== 'string' ||
    typeof args.tabId !== 'string' ||
    !isValidTerminalTabId(args.tabId) ||
    typeof args.leafId !== 'string' ||
    !isTerminalLeafId(args.leafId) ||
    args.connectionId ||
    !deps.runtime
  ) {
    return null
  }
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const previous =
    agentHookServer.getStatusSnapshotForPane(paneKey)[0] ?? readInterruptedStatus(paneKey)
  if (
    previous?.state !== 'working' ||
    previous.providerSessionOnly === true ||
    previous.connectionId !== null ||
    previous.agentType !== args.launchAgent ||
    !agentProviderSessionsEqual(
      args.launchAgent,
      previous.providerSession,
      args.resumeProviderSession
    )
  ) {
    return null
  }
  const runtime = deps.runtime
  let ptyId: string | null = null
  let dispose = (): void => {}
  let stopReadiness = (): void => {}
  let unsubscribeExit = (): void => {}
  let disposed = false
  let hookObserved = false
  let committed = false
  const enabled = () =>
    (deps.getSettings?.() ?? deps.store?.getSettings())?.autoContinueInterruptedSessions !== false
  const continuation = createInterruptedSessionContinuation({
    previous,
    launchToken: args.launchToken,
    enabled,
    claim: (key) =>
      claimInterruptedTurn(join(getCanonicalUserDataPath(), 'agent-hooks', 'continued-turns'), key),
    send: async (beforeWrite) => {
      const handle = runtime.getTerminalHandleForPaneKey(paneKey)
      if (!handle || getPtyIdForPaneKey(paneKey) !== ptyId) {
        throw new Error('resume_owner_unavailable')
      }
      const status = await runtime.getTerminalAgentStatus(handle)
      if (!status.isRunningAgent || status.status === 'permission' || status.status === 'working') {
        throw new Error('resume_not_ready')
      }
      return runtime.sendTerminalAgentPrompt(handle, INTERRUPTION_CONTINUATION, {
        beforeWrite: () => {
          if (getPtyIdForPaneKey(paneKey) !== ptyId) {
            throw new Error('resume_owner_changed')
          }
          beforeWrite()
        }
      })
    },
    record: (outcome) => {
      recordCrashBreadcrumb('session_auto_continue', { paneKey, outcome })
      console.info('[session-ledger] interrupted session auto-continue', {
        paneKey,
        outcome
      })
      dispose()
    }
  })
  const unsubscribe = agentHookServer.subscribeEnrichedStatus((event) => {
    if (
      event.paneKey === paneKey &&
      event.launchToken === args.launchToken &&
      !event.isReplay &&
      !event.restoredUnconfirmed
    ) {
      hookObserved = true
      stopReadiness()
    }
    continuation.observe(event)
  })
  const unsubscribeTeardown = registerPaneKeyTeardownListener((key) => {
    if (key === paneKey) {
      dispose()
    }
  })
  dispose = () => {
    disposed = true
    stopReadiness()
    unsubscribeExit()
    continuation.cancel()
    unsubscribe()
    unsubscribeTeardown()
  }
  return {
    commit(id: string, succeeded: boolean) {
      if (committed || disposed) {
        return
      }
      committed = true
      ptyId = id
      continuation.commit(succeeded)
      if (!succeeded) {
        dispose()
        return
      }
      if (disposed) {
        return
      }
      unsubscribeExit = runtime.subscribeToPtyExit(id, dispose)
      if (
        !disposed &&
        !hookObserved &&
        enabled() &&
        (args.launchAgent === 'omp' || args.launchAgent === 'pi' || args.launchAgent === 'opencode')
      ) {
        stopReadiness = watchInterruptedSessionReadiness({
          runtime,
          paneKey,
          ownsPane: () => !disposed && getPtyIdForPaneKey(paneKey) === id,
          enabled,
          observe: continuation.observe,
          event: {
            paneKey,
            connectionId: null,
            launchToken: args.launchToken as string,
            providerSession: previous.providerSession,
            hookEventName: 'SessionStart',
            payload: {
              agentType: previous.agentType,
              state: 'done',
              prompt: '',
              sessionBoundary: true
            }
          }
        })
      }
    },
    dispose
  }
}
