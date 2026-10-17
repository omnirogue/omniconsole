// `session.frameLog.*` switches the session frame log (session-count fix, step 0) on and off at
// runtime, and `session.sidebarCounts` reads the sidebar's counts as the window last rendered them.
// Both are the window and the local CLI only; neither changes a session.

import { z } from 'zod'
import {
  SESSION_FRAME_LOG_MAX_DURATION_MS,
  SESSION_FRAME_LOG_RPC,
  SESSION_SIDEBAR_COUNTS_RPC,
  type SessionFrameLogStatus
} from '../../../../shared/session-frame-log'
import {
  unavailableSessionSidebarCounts,
  type SessionSidebarCountsResult
} from '../../../../shared/session-sidebar-counts'
import {
  getRunningBuildIdentity,
  getSessionFrameLogStatus,
  setSessionFrameLogEnabled
} from '../../../observability/session-frame-log'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationLocalReader } from './session-organization'

const SetParams = z
  .object({
    enabled: z.boolean(),
    /** How long "on" lasts (default 8 h); restarts keep it until then. */
    durationMs: z.number().int().positive().max(SESSION_FRAME_LOG_MAX_DURATION_MS).optional()
  })
  .strict()

export const SESSION_FRAME_LOG_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_FRAME_LOG_RPC.set,
    params: SetParams,
    handler: (params, context): SessionFrameLogStatus => {
      assertOrganizationLocalReader(context)
      return setSessionFrameLogEnabled(params.enabled, 'rpc', { durationMs: params.durationMs })
    }
  }),
  defineMethod({
    name: SESSION_FRAME_LOG_RPC.status,
    params: null,
    handler: (_params, context): SessionFrameLogStatus => {
      assertOrganizationLocalReader(context)
      return getSessionFrameLogStatus()
    }
  }),
  defineMethod({
    name: SESSION_SIDEBAR_COUNTS_RPC,
    params: null,
    handler: async (_params, context): Promise<SessionSidebarCountsResult> => {
      assertOrganizationLocalReader(context)
      let result: unknown
      try {
        result = await context.runtime.requestSessionFolders({ kind: 'readSidebarCounts' })
      } catch (error) {
        // Why: no window (a headless relaunch) has no rendered sidebar; that is not zero sessions.
        return unavailableSidebarCounts(error instanceof Error ? error.message : String(error))
      }
      if (!result || typeof result !== 'object' || !('available' in result)) {
        // Why: a window from before this read answers nothing; say so rather than report zeros.
        return unavailableSidebarCounts(
          'This window cannot report its sidebar counts. Reload OmniConsole.'
        )
      }
      return { ...(result as SessionSidebarCountsResult), build: getRunningBuildIdentity() }
    }
  })
]

function unavailableSidebarCounts(reason: string): SessionSidebarCountsResult {
  return { ...unavailableSessionSidebarCounts(reason), build: getRunningBuildIdentity() }
}
