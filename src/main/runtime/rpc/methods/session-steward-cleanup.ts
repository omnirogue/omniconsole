// `sessionSteward.cleanupNow` (Work's Clean up now: the person asking) and `sessionSteward.cleanupRuns`
// (what Work shows). The automatic trigger has no RPC: only main's detector sets it.

import {
  SESSION_CLEANUP_RPC,
  type CleanupAdmission,
  type CleanupRunsView
} from '../../../../shared/session-cleanup-run'
import { admitCleanupRun, cleanupRunsView } from '../../../session-steward/cleanup-runs-runtime'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'

/** The desktop window's own RPC identity (`ipc/runtime.ts`). */
const DESKTOP_RENDERER_CLIENT_ID = 'desktop-renderer'

export const CLEANUP_CALLER_REFUSAL =
  'Clean up now runs from this computer’s OmniConsole window or its own omni CLI; a paired device, another computer or a dispatched worker cannot start it.'

/** This computer's window or its plain local CLI; never a paired device, a worker or a steward run. */
function assertCleanupCaller(context: RpcContext): void {
  const window = context.clientId === DESKTOP_RENDERER_CLIENT_ID
  const localCli = !context.clientId && !context.clientKind
  if (
    (!window && !localCli) ||
    context.pairedDeviceId ||
    context.orchestrationCapability ||
    context.unattendedCaller
  ) {
    throw new Error(CLEANUP_CALLER_REFUSAL)
  }
}

export const SESSION_CLEANUP_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_CLEANUP_RPC.now,
    params: null,
    handler: (_params, context): CleanupAdmission => {
      assertCleanupCaller(context)
      return admitCleanupRun('manual')
    }
  }),
  defineMethod({
    name: SESSION_CLEANUP_RPC.runs,
    params: null,
    handler: (_params, context): CleanupRunsView | null => {
      assertCleanupCaller(context)
      return cleanupRunsView()
    }
  })
]
