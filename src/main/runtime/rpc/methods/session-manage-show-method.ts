// `sessionManage.show` — `omni session show`: pulls a conversation into view beside the current
// one (or in its place) and highlights it. Changes no conversation, so nothing is audited.

import { SESSION_MANAGE_RPC } from '../../../../shared/session-manage-types'
import { callerDrivesHostWindow, showSession } from '../../../session-manage/session-manage-show'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { findBackgroundTerminal } from '../../../session-manage/session-manage-background-terminals'
import { defineMethod } from '../core'
import { SessionManageShowParams } from './session-manage-schemas'

export const SESSION_MANAGE_SHOW_METHOD = defineMethod({
  name: SESSION_MANAGE_RPC.show,
  params: SessionManageShowParams,
  handler: async (params, context) =>
    showSession(
      {
        readRows: () => readSidebarRows(context.runtime),
        relay: (request) => context.runtime.requestSessionFolders(request),
        findBackground: (target) =>
          findBackgroundTerminal(context.runtime.listBackgroundRuntimeOwnedTerminals(), target),
        adoptBackground: async (handle) => {
          const focused = await context.runtime.focusTerminal(handle, { navigateHost: true })
          return { tabId: focused.tabId, navigated: focused.navigated === true }
        }
      },
      {
        target: params.target,
        mode: params.mode ?? 'beside',
        flash: params.flash !== false,
        drivesHostWindow: callerDrivesHostWindow(context)
      }
    )
})
