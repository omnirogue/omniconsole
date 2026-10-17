import { SESSION_MANAGE_RPC } from '../../../../shared/session-manage-types'
import { handoffSession } from '../../../session-manage/session-manage-handoff'
import { consolidateSessions } from '../../../session-manage/session-manage-consolidate'
import { runtimeTransferDeps } from '../../../session-manage/session-manage-transfer-runtime'
import type { SessionTransferHostRequest } from '../../../session-manage/session-transfer-host-contract'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'
import {
  SessionManageHandoffParams,
  SessionManageConsolidateParams
} from './session-manage-schemas'
import { prepareSessionAction, type PreparedSessionAction } from './session-manage-support'

/** `--workspace` names a workspace on the other computer, so it only travels with `--host`. */
function hostMoveRequest(params: {
  host?: string
  workspace?: string
}): SessionTransferHostRequest | null {
  if (params.workspace !== undefined && params.host === undefined) {
    throw new InvalidArgumentError(
      '--workspace names the workspace on another computer; pass --host too.'
    )
  }
  return params.host === undefined
    ? null
    : {
        hostId: params.host,
        ...(params.workspace !== undefined ? { workspace: params.workspace } : {})
      }
}

export const SESSION_MANAGE_TRANSFER_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_MANAGE_RPC.handoff,
    params: SessionManageHandoffParams,
    handler: async (params, context) => {
      const host = hostMoveRequest(params)
      const source = await prepareSessionAction(context, params.target)
      const target =
        params.to === 'new' ? 'new' : await prepareSessionAction(context, { paneKey: params.to })
      return handoffSession(runtimeTransferDeps(context, source.actor, params, Boolean(host)), {
        actor: source.actor,
        sources: [source],
        target,
        note: params.note,
        dryRun: params.dryRun === true,
        ...(host ? { host } : {})
      })
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.consolidate,
    params: SessionManageConsolidateParams,
    handler: async (params, context) => {
      const host = hostMoveRequest(params)
      const sources: PreparedSessionAction[] = []
      for (const paneKey of params.panes) {
        sources.push(await prepareSessionAction(context, { paneKey }))
      }
      const target =
        params.into === 'new'
          ? 'new'
          : await prepareSessionAction(context, { paneKey: params.into })
      return consolidateSessions(
        runtimeTransferDeps(context, sources[0].actor, params, Boolean(host)),
        {
          actor: sources[0].actor,
          sources,
          target,
          skipBusy: params.skipBusy,
          dryRun: params.dryRun === true,
          ...(host ? { host } : {})
        }
      )
    }
  })
]
